# ciper

Easily instantiate a PR test workflow with jenkins and github

## install

```sh
npm i ciper --save
```

## example

Use ciper to poll the github API for various organizations to sync projects of
those organizations with jenkins in order for Test PR webhooks to work
seamlessly

```js
var Ciper = require('ciper');

var ciper = new Ciper({
  organizations: ['nodejitsu', 'warehouseai', 'godaddy']
  github: {
    url: 'https://api.github.com'
  },
  jenkins: 'http://myjenkinsurl',
  credentialsId: 'uuid', // pretend this is a UUID
  gitHubAuthId: '' // TODO: figure out what this is used for with the github plugin
});

//
// Will poll the github API every hour and attempt to sync all of the
// repositories
//
ciper.poll(3E6)
  .on('error', function (err) {
    // something bad happened, log it
    console.error(err);
  })
  .on('poll:start', function () {
    console.log('Github poll started');
  })
  .on('poll:finish', function () {
    console.log('Github poll finished, repos synced'); 
  })

```

## license
MIT
