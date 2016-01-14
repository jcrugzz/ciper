'use strict';

var EE = require('events').EventEmitter;
var path = require('path');
var url = require('url');
var fs = require('fs');
var async = require('async');
var Jenkins = require('jenkins');
var GitHulk = require('githulk');
var assign = require('object-assign');
var format = require('string-template');
var debug = require('diagnostics')('ciper');

module.exports = Ciper;

//
// 1. I need to add the hook events for both the git and github plugin into
// jenkins that will only trigger on PR and comments for a repo. Ensure the repo
// itself has a package.json in this process
// 2. I need to create the specific job for PRs in jenkins to correspond to this
// that `npm installs` runs the tests and gives a pass or fail.
//
// The above actions should be able to be done on demand for a specified repo,
// on demand for a specified organization as well and we should enable
// a component that polls various organizations and checks for repos that do not
// have this enabled and updates them
//
function Ciper(options) {

  //
  // This should be the SEED set but in general we should serialize this to disk
  // or pass some kind of simple database object to read from
  //
  this.organizations = options.orgs || options.organizations;
  //
  // Jenkins admins
  //
  this.admins = options.admins || [];
  this.nodeType = options.nodeType || '';

  //
  // Other properties that need to be templated into the jenkins build
  // TODO: Figure out a better way for these to be injected into the templating
  //
  this.credentialsId = options.credentialsId || '';

  this.gitHubAuthId = options.gitHubAuthId || '';

  //
  // Expected to be an object with `url` and `tokens` keys
  //
  this.git = new GitHulk(options.github);

  //
  // XML used to create the jenkins job that we need to template
  //
  this.xmlPath = options.xmlPath || path.join(__dirname, 'build.xml');

  //
  // Eventually we might want this to be a set of jenkins instances that are
  // mapped to a single organization or set of repos if we want to get fancy.
  // For now assume 1
  //
  this.jenkinsUrl = options.jenkins;
  this.jenkins = new Jenkins(options.jenkins);
  this.interval = options.interval || 36E5; // 1 hr

  //
  // Poll GitHub and setup any jobs that are necessary every so often. This will
  // ensure our jobs are kept up to date
  //
  if (options.start) {
    return this.poll().unref();
  }

  //
  // Default async limit since we are doing a lot of concurrent things
  //
  this.limit = options.limit || 10;

  //
  // Not sure if these are useful yet
  //
  this.pollDefaults = {};
  this.permitAll = options.permitAll || false;
}

Ciper.prototype = new EE();
Ciper.prototype.constructor = Ciper;

/**
 * Poll github and check each repository and decide if a jenkins job should be
 * created
 */
Ciper.prototype.syncOrgs = function syncOrgs(organizations, callback) {
  if (!callback && typeof organizations === 'function') {
    callback = organizations;
    organizations = null;
  }

  var orgs = organizations || this.organizations;
  if (!orgs) return void setImmediate(callback, new Error('Requires organizations'))
  if (!Array.isArray(orgs)) { orgs = [orgs]; }

  debug('sync orgs start %s', orgs);
  async.eachLimit(orgs, this.limit, (org, next) => {
    this.sync(assign({
      organization: org
    }, this.pollDefaults), next);
  }, err => {
    if (err) { return callback(err); }

    debug('sync orgs finish %s', orgs);
    callback();
  });

};

/**
 * Alias to syncOrgs with polling events
 */
Ciper.prototype._pollSyncOrgs = function () {
  this.emit('poll:start');
  this.syncOrgs(err => {
    if (err) { return this.emit('error', err); }
    this.emit('poll:finish');
  });
};

/**
 * Poll and attempt to sync orgs every defined interval
 */
Ciper.prototype.poll = function (interval) {
  this._timer = setInterval(
    this._pollSyncOrgs.bind(this),
    interval || this.interval
  );

  return this;
};

/**
 * Generate a sync/unsync function for some better code reuse
 */
Ciper.prototype.gen = function (name, execute) {
  return (options, callback) => {
    var org = typeof options === 'string'
      ? options
      : options.organization;

    debug(name + ':start %s', org);
    //
    // 1. List all the repos for a given organization
    //
    this.git.repository.list(org, {
      organization: true
    }, (err, result) => {
      if (err) { return callback(err); }
      //
      // Use ssh_url because we can parse it with githulk and we will need it to
      // properly template the XML for jenkins
      //
      var repos = result.map(r => r.ssh_url);
      //
      // 2. Iterate over the repos and check if they are valid
      // targets and return the proper data structure that we want for setting up
      // the repos for testing
      //
      async.mapLimit(repos, this.limit,
        this.extractNpm.bind(this),
      (er, packages) => {
        if (er) { return callback(er); }
        //
        // 3. Filter out the invalid targets and setup each package in both github
        // and in jenkins.
        //
        // Remark: In the future this jenkins should be configurable by repo or
        // org
        //
        async.eachLimit(packages.filter(Boolean), this.limit,
          execute,
        e => {
          if (e) { return callback(e); }
          debug(name + ':finish %s', org);
          this.emit(name, org);
          callback();
        });
      });
    });

  };
};

/**
 * Sync the specified organization/repos based on options given
 */
Ciper.prototype.sync = function (options, callback) {
  return this.gen('sync', this.setup.bind(this))(options, callback);
};

/**
 * Unsync specified organization/repos based on options
 */
Ciper.prototype.unsync = function (options, callback) {
  return this.gen('unsync', this.unsetup.bind(this))(options, callback);
};

Ciper.prototype.resync = function (options, callback) {
  return this.gen('resync', this.updater.bind(this))(options, callback);
};

/**
 * Fetch the contents of the package.json (if it exists) and return the package
 * name. Maybe in the future this could be configurable and more generic
 *
 * @param {String} user/repo
 */
Ciper.prototype.extractNpm = function (repo, callback) {
  debug('extract:start %s', repo);
  this.git.repository.contents(repo, {
    path: 'package.json'
  }, (err, results) => {
    results = results || {};
    if (err && err.statusCode !== 404) { return callback(err); }
    debug('extract:finish %s %j', repo, results);
    //
    // See if we have to re-encode it to utf8 first
    //
    var pkg = tryParse(new Buffer(results.content || '', 'base64').toString('utf8'));

    if (!pkg) { return callback(null, null); }
    //
    // Default our data structure that we pass around for the rest of the
    // functions needing execution
    //
    callback(null, this.defaults(pkg, repo));

  });
};

/**
 * Default the package/repo based data structure that we pass around and is
 * needed for templating the jenkins job
 */
Ciper.prototype.defaults = function (pkg, repo) {
  var pack = {};
  var name;
  //
  // Extract proper repo URL or use the one passed in.
  //
  repo = repo || pkg.repo || (pkg.repository || {}).url;
  var proj = this.git.project(repo);

  pack.repo = repo;
  pack.short = pkg.short || [proj.user, proj.repo].join('/');

  //
  // If we are scoped normalize the name to something `-` based.
  // This keeps us backwards compatible with naming
  //
  if (/^@/.test(pkg.name)) {
    name = pkg.name.slice(1).split('/').join('-');
  }

  pack.name = name || pkg.name;
  //
  // Default to 4.2 because thats what we should be assuming at this point
  //
  pack.node = (pkg.engines || pkg.engine || {}).node || '4.2';

  //
  // Copy over an arbitrary keys that might matter when it comes to templating,
  // this makes us more flexible
  //
  return Object.keys(pkg).reduce(function (acc, key) {
    if (!acc[key]) { acc[key] = pkg[key]; }
    return acc;
  }, pack);
};

/**
 * Setup a single repo
 *
 * @param {Object} obj.repo obj.name || packageName
 */
Ciper.prototype.setup = function (pkg, callback) {
  //
  // If we are called externally we should make sure we have the right data
  // structure
  //
  pkg = this.defaults(pkg);

  var repo = pkg.repo;
  debug('setup:start %s', repo)
  async.parallel([
    this.hooks.bind(this, repo),
    this.createJob.bind(this, pkg)
  ], err => {
    if (err) { return callback(err); }
    debug('setup:finish %s', repo);
    callback();
  });
};

/**
 * Temp function for doing update on a jenkins job
 */
Ciper.prototype.updater = function (pkg, callback) {
  pkg = this.defaults(pkg);
  this.updateJob(pkg, callback);
}

/**
 * un-setup the given package
 */
Ciper.prototype.unsetup = function (pkg, callback) {
  pkg = this.defaults(pkg);
  var repo = pkg.repo;
  debug('unsetup start %j', pkg);
  async.parallel([
    this.deleteHooks.bind(this, repo),
    this.deleteJob.bind(this, pkg)
  ], err => {
    if (err) { return callback(err); }
    debug('unsetup finish %j', pkg);
    callback();
  })

};

/**
 * Setup Webhooks for repo if they dont already exist
 */
Ciper.prototype.hooks = function (repo, callback) {
  debug('hooks:start %s', repo);
  this.git.webhooks.list(repo, (err, results) => {
    if (err) { return callback(err); }
    debug('hooks:finish %s', repo)
    //
    // Establish that we have the correct hooks enabled
    //
    var hooks = results.map(
      hook => validHook(hook.name)
        ? hook.name
        : null).filter(Boolean);
    //
    // No-op if they already exist
    //
    if (hooks.length >= 2) {
      debug('hooks:extra No-op, %s already synced', repo);
      return callback();
    }

    this.createHooks(repo, callback);
  });
};

/**
 * Create the jenkins jobs and template the XML based on the repo and package
 * name
 */
Ciper.prototype.createJob = function (pkg, callback) {
  var repo = pkg.repo;
  var name = pkg.name;
  debug('jenkins:create %s - %s', repo, name);

  //
  // Read the path to the XML file we need to template
  //
  fs.readFile(this.xmlPath, 'utf8', (err, xml) => {
    if (err) { return callback(err); }

    //
    // XXX. Maybe make this more configurable in the future
    //
    var templated = this.templateXml(xml, assign({
      admins: this.admins.join(' '),
      orgs: (this.organizations || []).join(' '),
      permitAll: !this.organizations || this.permitAll ? true : false,
      credentialsId: this.credentialsId,
      gitHubAuthId: this.gitHubAuthId,
      nodeType: this.nodeType,
    }, pkg));

    this.jenkins.job.create([name, 'build', 'pr'].join('-'), templated, err => {
      if (err && /already exists/.test(err.message)) return callback();

      callback(err);
    });
  });
};

/**
 * Modify the jenkins job to permitAll people
 */
Ciper.prototype.updateJob = function (pkg, callback) {
  var repo = pkg.repo;
  var name = pkg.name;
  debug('jenkins:update %s - %s', repo, name);
  var key = [name, 'build', 'pr'].join('-');

  this.jenkins.job.config(key, (err, config) => {
    if (err) {
      debug('jenkins:update %s - Error: %s', name, err.message);
      return callback(err);
    }
    if (!config) {
      debug('jenkins:update %s - No job config found', name);
      return callback();
    }

    config = config.replace('<permitAll>false</permitAll>', '<permitAll>true</permitAll>');
    this.jenkins.job.config(key, config, (err) => {
      if (err) {
        debug('jenkins:update %s - Error: %s', name, err.message);
        return callback(err);
      }
      debug('jenkins:update %s - Success!', name);
      callback();
    });
  });
};

/**
 * Delete the jenkins job
 */
Ciper.prototype.deleteJob = function (pkg, callback) {
  var name = pkg.name;

  this.jenkins.job.destroy([name, 'build', 'pr'].join('-'), callback);
};

/**
 * Template the xml for the job we are creating in jenkins
 */
Ciper.prototype.templateXml = function (xml, pkg) {
  return format(xml, pkg);
};

/**
 * Create jenkins webhooks based on predefined settings
 *
 * @param repo
 */
Ciper.prototype.createHooks = function (repo, callback) {
  async.parallel([
    this.makeHook.bind(this, repo, {
      name: 'jenkins',
      config: {
        jenkins_hook_url: url.resolve(this.jenkinsUrl, '/github_webhook/')
      },
      events: ['push'],
      active: true
    }),
    this.makeHook.bind(this, repo, {
      name: 'web',
      config: {
        url: url.resolve(this.jenkinsUrl, '/ghprbhook/')
      },
      events: ['pull_request', 'pull_request_review_comment', 'issue_comment'],
      active: true
    })
  ], callback);
};

Ciper.prototype.deleteHooks = function (repo, callback) {
  debug('Start delete jenkins hooks for %s', repo);
  async.waterfall([
    this.git.webhooks.list.bind(this.git.webhooks, repo),
    this._deleteHooks.bind(this, repo)
  ], function done(err) {
    if (err) return callback(err);
    debug('finish delete jenkins hooks for %s', repo);
    callback();
  });
};

/**
 * Given the results and the repo, delete the hooks that we care about
 */
Ciper.prototype._deleteHooks = function (repo, results, callback) {
  var optsArr = results.map(
    res => validHook(res.name)
      ? { id: res.id }
      : null).filter(Boolean);

  async.each(optsArr,
      this.git.webhooks.delete.bind(this.git.webhooks, repo),
    callback
  );
};


Ciper.prototype.makeHook = function (repo, options, fn) {
  this.git.webhooks.create(repo, options, fn);
};

/**
 * Destroy the instance or at least clean some things up
 */
Ciper.prototype.destroy = function destroy() {
  clearInterval(this._timer);
};

/**
 * Unref the setInterval so we don't keep the event loop open if we dont want
 */
Ciper.prototype.unref = function unref() {
  this._timer.unref();
  return this;
};

/**
 * Is this a valid hook name?
 * We assume no other custom webhooks here
 * TODO: Be more robust with multiple `web` hooks
 */
function validHook(name) {
  return name === 'jenkins' || name === 'web';
}

function tryParse(data) {
  var json;

  try {
    json = JSON.parse(data);
  } catch (ex) {}

  return json;
}
