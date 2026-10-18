'use strict';

// A test must replace its transport explicitly. Missing mocks fail before I/O.
const deny = () => { throw Object.assign(new Error('External network blocked by payment test guard'), { code: 'TEST_NETWORK_FORBIDDEN' }); };
for (const name of ['http', 'https']) {
  require(name).request = deny;
  require(name).get = deny;
}
require('net').connect = deny;
require('net').createConnection = deny;
require('tls').connect = deny;
global.fetch = deny;
process.env.MINIPROGRAM_APPSECRET = '';
process.env.PAYMENT_TEST_MODE = 'true';
