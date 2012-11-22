/*
 * Copyright (c) 2012 Joyent Inc. All rights reserved.
 *
 * Some base imgapi-cli tests.
 */

var format = require('util').format;
var exec = require('child_process').exec;


// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;



before(function (next) {
    next();
});

test('imgapi-cli --version', function (t) {
    exec('imgapi-cli --version', function (err, stdout, stderr) {
        t.ifError(err, err);
        t.equal(stderr, '', 'stderr');
        t.ok(/^imgapi-cli \d+\.\d+\.\d+/.test(stdout), 'stdout is a version');
        t.end();
    });
});
