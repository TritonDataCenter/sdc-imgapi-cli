/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * The main entry point for an imgapi-cli instance.
 */

var util = require('util');
var assert = require('assert-plus');
var nopt = require('nopt');
var sprintf = require('extsprintf').sprintf;
var IMGAPI = require('sdc-clients/lib/imgapi');

var common = require('./common');
var errors = require('./errors');



//---- internal support stuff



//---- CLI object

function CLI(options) {
    assert.object(options, 'options');
    assert.string(options.name, 'options.name');
    assert.optionalString(options.description, 'options.description');
    assert.string(options.url, 'options.url');

    var self = this;
    this.name = options.name;
    this.description = options.description;
    this.url = options.url;
    this.client = new IMGAPI({url: this.url});

    // Load subcmds.
    this.subcmds = {};
    this.aliases = {};
    Object.keys(this.constructor.prototype)
        .filter(function (funcname) { return /^do_/.test(funcname); })
        .sort()
        .forEach(function (funcname) {
            var name = funcname.slice(3);
            var func = self.constructor.prototype[funcname];
            self.subcmds[name] = func;
            self.aliases[name] = name;
            (func.aliases || []).forEach(function (alias) {
                self.aliases[alias] = name;
            });
        });

    this.helpcmds = {};
    Object.keys(this.constructor.prototype)
        .filter(function (funcname) { return /^help_/.test(funcname); })
        .sort()
        .forEach(function (funcname) {
            var name = funcname.slice(5);
            var func = self.constructor.prototype[funcname];
            self.helpcmds[name] = func;
        });
}


/**
 * CLI mainline.
 *
 * @param argv {Array}
 * @param callback {Function} `function (err)`
 */
CLI.prototype.main = function main(argv, callback) {
    try {
        var opts = this.parseArgv(argv);
    } catch (e) {
        return callback(e);
    }
    var args = opts.argv.remain;
    if (opts.version) {
        console.log(this.name + ' ' + common.getVersion());
        return callback();
    }
    if (opts.help || args.length === 0) {
        return this.printHelp(callback);
    }

    var subcmd = args.shift();
    return this.dispatch(subcmd, args, callback);
}


/**
 * Parse argv, return parsed object, throw if error.
 */
CLI.prototype.parseArgv = function parseArgv(argv) {
    var longOpts = {
        'help': Boolean,
        'version': Boolean,
        'debug': [Boolean, Array]
    };
    var shortOpts = {
        'h': ['--help'],
        'd': ['--debug']
    };
    var opts = nopt(longOpts, shortOpts, argv, 2);

    // Die on unknown opts.
    var extraOpts = {};
    Object.keys(opts).forEach(function (o) { extraOpts[o] = true; });
    delete extraOpts.argv;
    Object.keys(longOpts).forEach(function (o) { delete extraOpts[o]; });
    extraOpts = Object.keys(extraOpts);
    if (extraOpts.length) {
        throw new errors.UnknownOptionError('-' + extraOpts.join(', -'));
    }

    return opts;
}

CLI.prototype.printHelp = function printHelp(callback) {
    var self = this;
    var lines = [];
    if (this.description) {
        lines.push(this.description);
    }
    lines = lines.concat([
        'Usage:',
        '    %s [OPTIONS] COMMAND [ARGS...]',
        '    %s help COMMAND',
        '',
        'Options:',
        '    -h, --help          show this help message and exit',
        '    --version           show version and exit',
        '    -d, --debug         debug logging',
        '',
        'Commands:'
    ]);
    var template = '    %-18s  %s';
    Object.keys(this.subcmds).forEach(function (name) {
        var func = self.subcmds[name];
        var names = name;
        if (func.aliases) {
            names += sprintf(' (%s)', func.aliases.join(', '));
        }
        var line = sprintf(template, names, func.description || '');
        lines.push(line);
    });
    console.log(lines.join('\n').replace(/%s/g, this.name));
    callback();
}

/**
 * Dispatch to the appropriate "do_SUBCMD" function.
 */
CLI.prototype.dispatch = function dispatch(subcmd, args, callback) {
    var self = this;
    var name = this.aliases[subcmd];
    if (!name) {
        return callback(new errors.UnknownCommandError(subcmd));
    }
    var func = this.subcmds[name];
    var opts = {}; // TODO: option processing
    return func.call(this, subcmd, {}, args, callback);
}

CLI.prototype.do_help = function do_help(subcmd, opts, args, callback) {
    if (args.length === 0) {
        return this.printHelp(callback);
    }
    var alias = args[0];
    var name = this.aliases[alias];
    if (!name) {
        return callback(new errors.UnknownCommandError(alias));
    }

    // If there is a `.help_NAME`, use that.
    var helpfunc = this.helpcmds[name];
    if (helpfunc) {
        return helpfunc.call(this, alias, callback);
    }

    var func = this.subcmds[name];
    if (func.help) {
        console.log(func.help);
    } else if (func.description) {
        console.log(func.description);
    } else {
        self.error(sprintf('no help for "%s"', alias));
        return 1
    }
}
CLI.prototype.do_help.aliases = ['?'];
CLI.prototype.do_help.description = 'Give detailed help on a specific sub-command.';

CLI.prototype.help_help = function help_help(subcmd, callback) {
    this.printHelp(callback);
};


CLI.prototype.do_ping = function do_ping(subcmd, opts, args, callback) {
    var self = this;
    this.client.ping(function (err, pong) {
        if (err) {
            callback(new errors.APIError(err))
        }
        console.log("pong");
    });
};
CLI.prototype.do_ping.description = 'Ping the IMGAPI to see if it is up.';



//---- exports

module.exports = CLI;
