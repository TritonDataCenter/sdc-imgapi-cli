/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * Some base imgapi-cli tests.
 */

var exec = require('child_process').exec;
var test = require('tape');


test('imgapi-cli --version', function (t) {
    exec('./bin/imgapi-cli --version', function (err, stdout, stderr) {
        t.ifError(err, err);
        t.equal(stderr, '', 'stderr');
        t.ok(/^imgapi-cli \d+\.\d+\.\d+/.test(stdout), 'stdout is a version');
        t.end();
    });
});
