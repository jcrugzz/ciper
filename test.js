'use strict';

var assume = require('assume');
var sinon = require('sinon');
var proxyquire = require('proxyquire').noCallThru().noPreserveCache();

assume.use(require('assume-sinon'));

function MockJenkins(url) {
  this.job = {};
  this.job.create = sinon.stub().yields();
  this.job.destroy = sinon.stub().yields();
}

describe('Ciper tests', function () {
  this.timeout(3E6);

  var Ciper = proxyquire('./', {
    jenkins: MockJenkins
  });

  var ciper;

  beforeEach(function () {
    ciper = new Ciper({
      github: {
        tokens: [process.env.GITHUB_TOKEN]
      },
      jenkins: 'http://myjenkinsurl.com'
    });
  });

  function cleanupper(arg) {
    return (done) => {
      ciper.unsync(arg, done);
    };
  }

  it('should sync orgs with the organizations passed in', function (done) {
    var cleanup = cleanupper('webhooks-test');
    ciper.syncOrgs(['webhooks-test'], function (err, result) {
      assume(err).to.be.falsey();
      assume(ciper.jenkins.job.create).is.called(1);
      cleanup(done);
    });
  });

  it('should be able to directly sync a single organization', function (done) {
    var cleanup = cleanupper('webhooks-test');
    ciper.sync('webhooks-test', function (err, result) {
      assume(err).to.be.falsey();
      assume(ciper.jenkins.job.create).is.called(1);
      cleanup(done);
    });
  });

  it('should be able setup a package', function (done) {
    ciper.setup({
      repo: 'webhooks-test/didactic-octo-squeegee',
      name: 'didactic-octo-squeegee'
    }, function (err) {
      assume(err).to.be.falsey();
      assume(ciper.jenkins.job.create).is.called(1);
      done();
    });
  });

  it('should be able to unsetup a package', function (done) {
    ciper.unsetup({
      repo: 'webhooks-test/didactic-octo-squeegee',
      name: 'didactic-octo-squeegee'
    }, function (err) {
      assume(err).to.be.falsey();
      assume(ciper.jenkins.job.destroy).is.called(1);
      done();
    });
  });
});
