/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Dump for shared imgapi-cli stuff that doesn't fit in another source file.
 */


function getVersion() {
    return require('../package.json').version;
}


/**
 * Get a password from stdin.
 *
 * Adapted from <http://stackoverflow.com/a/10357818/122384>.
 *
 * @param prompt {String} Optional prompt. Default 'Password: '.
 * @param callback {Function} `function (cancelled, password)` where
 *      `cancelled` is true if the user aborted (Ctrl+C).
 *
 * Limitations: Not sure if backspace is handled properly.
 */
function getPassword(prompt, callback) {
    if (callback === undefined) {
        callback = prompt;
        prompt = undefined;
    }
    if (prompt === undefined) {
        prompt = 'Password: ';
    }
    if (prompt) {
        process.stdout.write(prompt);
    }

    var stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    var password = '';
    stdin.on('data', function (ch) {
        ch = ch + '';

        switch (ch) {
        case '\n':
        case '\r':
        case '\u0004':
            // They've finished typing their password
            process.stdout.write('\n');
            stdin.setRawMode(false);
            stdin.pause();
            callback(false, password);
            break;
        case '\u0003':
            // Ctrl-C
            callback(true);
            break;
        default:
            // More passsword characters
            process.stdout.write('*');
            password += ch;
            break;
        }
    });
}


function objCopy(obj) {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
        copy[k] = obj[k];
    });
    return copy;
}


/*
 * Set the process exit code, only using `process.exit` if necessary.
 *
 * We'd like to NOT use `process.exit` because node then doesn't in
 * general allow std handles to flush. For some node versions it
 * *will* flush if stdout is a TTY. However, you are then screwed
 * when piping output to anything. IOW, that is no help.
 *
 * In node 0.12, `process.exitCode` provided a way to set the exit
 * code without the hard immediate `process.exit()`.
 *
 * Note: A side-effect of avoiding `process.exit()` is that this process will
 * hang if there are active node handles. Arguably that means this app has
 * other bugs to deal with.
 */
function softProcessExit(code) {
    var supportsProcessExitCode = true;
    var nodeVer = process.versions.node.split('.').map(Number);
    if (nodeVer[0] === 0 && nodeVer[1] <= 10) {
        supportsProcessExitCode = false;
    }

    if (supportsProcessExitCode) {
        process.exitCode = code;
    } else if (code !== 0) {
        process.exit(code);
    }
}


//---- exports

module.exports = {
    getVersion: getVersion,
    getPassword: getPassword,
    objCopy: objCopy,
    softProcessExit: softProcessExit
};
