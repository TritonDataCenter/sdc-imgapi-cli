/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * The main entry point for an imgapi-cli instance.
 */

var util = require('util'),
    format = util.format;
var path = require('path');
var fs = require('fs');
var assert = require('assert-plus');
var nopt = require('nopt');
var sprintf = require('extsprintf').sprintf;
var imgapi = require('sdc-clients/lib/imgapi');
var bunyan = require('bunyan');

var common = require('./common'),
    objCopy = common.objCopy;
var errors = require('./errors');



//---- internal support stuff

var DEFAULT_IDENTITY_FILES = [
    path.resolve(process.env.HOME, '.ssh/id_rsa')
];


//---- CLI object

/**
 * Create an IMGAPI CLI instance.
 *
 * @param options {Object}:
 *      - @param name {String} Required. The CLI name, e.g. "joyent-imgadm".
 *      - @param url {String} Required. The IMGAPI URL.
 *      - @param description {String} Optional.
 *      - @param auth {String} Optional. One of "none" (default), "basic",
 *          "signature". This will impact what CLI options are available
 *          and auth used (if any) on requests to the IMGAPI.
 *      - @param envopts {Array} Optional. An ordered mapping of envvar name
 *          to associated CLI options. E.g.
 *                  [['FOO_CLI_IDENTITY': 'identity'], ...]
 *          will result in `--identity=$FOO_CLI_IDENTITY` effectively being
 *          added to argv if `--identity` wasn't already specified.
 */
function CLI(options) {
    assert.object(options, 'options');
    assert.string(options.name, 'options.name');
    assert.optionalString(options.description, 'options.description');
    assert.string(options.url, 'options.url');
    assert.optionalString(options.auth, 'options.auth');
    assert.optionalArrayOfObject(options.envopts, 'options.envopts');

    var self = this;
    this.auth = options.auth || 'none';
    assert.ok(['none', 'basic', 'signature'].indexOf(this.auth) !== -1);
    this.name = options.name;
    this.description = options.description;
    this.url = options.url;
    this.envopts = options.envopts;

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
    var self = this;
    this.handleArgv(argv, this.envopts, function (err, opts) {
        if (err) {
            return callback(err);
        }

        var args = opts.argv.remain;
        if (opts.version) {
            console.log(self.name + ' ' + common.getVersion());
            return callback();
        }
        if (opts.help || args.length === 0) {
            return self.printHelp(callback);
        }

        /*
         * Logging is to stderr. By default we log at the 'warn' level -- but
         * that is almost nothing. Logging is in Bunyan format (hence very
         * limited default logging), so need to pipe via `bunyan` for readable
         * output (at least until bunyan.js supports doing it inline).
         *
         * Admittedly this is a bit of a pain:
         *
         *      imgapi-cli ping -ddd 2>&1 | bunyan
         *
         * Use -d|--debug to increase the logging:
         * - 1: info
         * - 2: debug
         * - 3: trace and enable 'src' (source file location information)
         */
        var level = 'warn';
        var src = false;
        if (opts.debug) {
            if (opts.debug.length === 1) {
                level = 'info'
            } else if (opts.debug.length === 2) {
                level = 'debug';
            } else {
                level = 'trace';
                src = true;
            }
        }
        self.log = bunyan.createLogger({
            name: self.name,
            streams: [{
                stream: process.stderr,
                level: level
            }],
            src: src,
            serializers: bunyan.stdSerializers
        });
        self.log.debug({opts: opts, argv: argv}, 'parsed argv');

        var imgapiOpts = {
            url: self.url,
            log: self.log.child({component: 'api'}, true)
        };
        if (self.auth === 'basic') {
            imgapiOpts.user = opts.user;
            imgapiOpts.password = opts.password;
            self.log.info({user: imgapiOpts.user}, 'basic auth');
        } else if (self.auth === 'signature') {
            //TODO: decide on whether '-i identity' (ssh) or '-k keyId' (manta) style.
            if (opts.user && opts.identities) {
                imgapiOpts.sign = imgapi.cliSigner({
                    keyIds: opts.identities,
                    log: imgapiOpts.log,
                    user: opts.user
                });
            }
            imgapiOpts.user = opts.user;
            self.log.info({user: imgapiOpts.user || '(none)',
                identities: opts.identities || '(none)'},
                'signature auth');
        }
        self.client = imgapi.createClient(imgapiOpts);

        var subcmd = args.shift();
        return self.dispatch(subcmd, argv, callback);
    });
}


/**
 * Process options.
 *
 * @param argv {Array}
 * @param callback {Function} `function (err, opts)`.
 */
CLI.prototype.handleArgv = function handleArgv(argv, envopts, callback) {
    var longOpts = this.longOpts = {
        'help': Boolean,
        'version': Boolean,
        'debug': [Boolean, Array]
    };
    var shortOpts = this.shortOpts = {
        'h': ['--help'],
        'd': ['--debug']
    };
    if (this.auth === 'basic') {
        longOpts.user = String;
        shortOpts.u = ['--user'];
    } else if (this.auth === 'signature') {
        longOpts.user = String;
        shortOpts.u = ['--user'];
        longOpts.identity = [String, Array];
        shortOpts.i = ['--identity'];
    }

    var opts = nopt(longOpts, shortOpts, argv, 2);

    // envopts
    ;(envopts || []).forEach(function (envopt) {
        var envname = envopt[0];
        var optname = envopt[1];
        if (process.env[envname] && !opts[optname]) {
            //console.log('set `opts.%s = "%s" from %s envvar',
            //    optname, process.env[envname], envname);
            opts[optname] = process.env[envname];
        }
    });
    if (opts.identity) {
        if (!Array.isArray(opts.identity)) {
            opts.identities = [opts.identity];
        } else {
            opts.identities = opts.identity;
        }
        delete opts.identity;
    }

    if (this.auth === 'signature') {
        if (!opts.identities) {
            for (var i=0; i < DEFAULT_IDENTITY_FILES.length; i++) {
                var p = DEFAULT_IDENTITY_FILES[i];
                if (fs.existsSync(p)) {
                    opts.identities = [p];
                    break;
                }
            }
        }
        callback(null, opts);
    } else if (this.auth === 'basic') {
        if (opts.user) {
            if (opts.user.indexOf(':') === -1) {
                var prompt = format('Enter IMGAPI password for user "%s": ',
                    opts.user);
                common.getPassword(prompt, function (err, password) {
                    if (err) {
                        return callback(err);
                    }
                    opts.password = password;
                    callback(null, opts);
                });
            } else {
                var colon = opts.user.indexOf(':');
                opts.password = opts.user.slice(colon + 1);
                opts.user = opts.user.slice(0, colon);
                callback(null, opts);
            }
        } else {
            callback(null, opts);
        }
    } else {
        callback(null, opts);
    }
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
        '    -h, --help          Show this help message and exit.',
        '    --version           Show version and exit.',
        '    -d, --debug         Debug logging. Multiple times for more.'
    ]);
    if (this.auth === 'basic') {
        lines = lines.concat([
            '    -u, --user <user:password>',
            '                        Basic auth user and (optionally) password.',
            '                        If no password is given, you will be prompted.',
        ]);
    } else if (this.auth === 'signature') {
        lines = lines.concat([
            '    -u, --user <user>   Username',
            '    -i <identity-file>  Path to identity file (private RSA key).',
        ]);
    }

    if (self.envopts && self.envopts.length) {
        var envTemplate = '    %-23s  %s';
        lines.push('');
        lines.push('Environment:');
        self.envopts.forEach(function (envopt) {
            var envname = envopt[0];
            var optname = envopt[1];
            lines.push(sprintf(envTemplate, envname, 'Fallback for --'+optname));
        });
    }

    var cmdTemplate = '    %-18s  %s';
    lines = lines.concat([
        '',
        'Commands:'
    ]);
    Object.keys(this.subcmds).forEach(function (name) {
        var func = self.subcmds[name];
        var names = name;
        if (func.aliases) {
            names += sprintf(' (%s)', func.aliases.join(', '));
        }
        var desc = (func.description ?
            func.description.split('\n', 1)[0] : '');
        desc = desc.replace(/\$NAME/, self.name);
        var line = sprintf(cmdTemplate, names, desc);
        lines.push(line);
    });
    console.log(lines.join('\n').replace(/%s/g, this.name));
    callback();
}

/**
 * Dispatch to the appropriate "do_SUBCMD" function.
 */
CLI.prototype.dispatch = function dispatch(subcmd, argv, callback) {
    var self = this;
    var name = this.aliases[subcmd];
    if (!name) {
        return callback(new errors.UnknownCommandError(subcmd));
    }
    var func = this.subcmds[name];

    // Reparse the whole argv with merge global and subcmd options. This
    // is the only way (at least with `nopt`) to correctly parse subcmd opts.
    // It has the bonus of allowing *boolean* subcmd options before the
    // subcmd name, if that is helpful. E.g.:
    //      `joyent-imgadm -u trentm -j listimages`
    var longOpts = objCopy(this.longOpts);
    if (func.longOpts) {
        Object.keys(func.longOpts).forEach(
            function (k) { longOpts[k] = func.longOpts[k]; })
    }
    var shortOpts = objCopy(this.shortOpts);
    if (func.shortOpts) {
        Object.keys(func.shortOpts).forEach(
            function (k) { shortOpts[k] = func.shortOpts[k]; })
    }
    var opts = nopt(longOpts, shortOpts, argv, 2);

    // Die on unknown opts.
    var extraOpts = objCopy(opts);
    delete extraOpts.argv;
    Object.keys(longOpts).forEach(function (o) { delete extraOpts[o]; });
    extraOpts = Object.keys(extraOpts);
    if (extraOpts.length) {
        return callback(new errors.UnknownOptionError(extraOpts.join(', ')));
    }

    var args = opts.argv.remain;
    delete opts.argv;
    assert.equal(subcmd, args.shift());
    return func.call(this, subcmd, opts, args, callback);
}

CLI.prototype.do_help = function do_help(subcmd, opts, args, callback) {
    var self = this;
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
    if (func.description) {
        var desc = func.description.replace(/\$NAME/, self.name);
        console.log(desc);
    } else {
        callback(new errors.ImgapiCliError(format('no help for "%s"', alias)));
    }
}
CLI.prototype.do_help.aliases = ['?'];
CLI.prototype.do_help.description = 'Give detailed help on a specific sub-command.';

CLI.prototype.help_help = function help_help(subcmd, callback) {
    this.printHelp(callback);
};


CLI.prototype.do_ping = function do_ping(subcmd, opts, args, callback) {
    var self = this;
    this.client.ping(function (err, pong, res) {
        self.log.trace({err: err, res: res}, 'ping');
        if (err) {
            return callback(new errors.APIError(err))
        }
        console.log("pong");
    });
};
CLI.prototype.do_ping.description = 'Ping the IMGAPI to see if it is up.';


/**
 * Print a table of the given items.
 *
 * @params items {Array}
 * @params options {Object}
 *      - `columns` {String} of comma-separated field names for columns
 *      - `skipHeader` {Boolean} Default false.
 *      - `sort` {String} of comma-separate fields on which to alphabetically
 *        sort the rows. Optional.
 *      - `validFields` {String} valid fields for `columns` and `sort`
 */
function tabulate(items, options) {
    assert.arrayOfObject(items, 'items');
    assert.object(options, 'options');
    assert.string(options.columns, 'options.columns');
    assert.optionalBool(options.skipHeader, 'options.skipHeader');
    assert.optionalString(options.sort, 'options.sort');
    assert.string(options.validFields, 'options.validFields');

    // Validate.
    var validFields = options.validFields.split(',');
    var columns = options.columns.split(',');
    var sort = options.sort ? options.sort.split(',') : [];
    columns.forEach(function (c) {
        if (validFields.indexOf(c) === -1) {
            throw new TypeError(format('invalid output field: "%s"', c));
        }
    });
    sort.forEach(function (s) {
        if (validFields.indexOf(s) === -1) {
            throw new TypeError(format('invalid sort field: "%s"', s));
        }
    });

    // Determine columns and widths.
    var widths = {};
    columns.forEach(function (c) { widths[c] = 0 });
    items.forEach(function (i) {
        columns.forEach(function (c) {
            widths[c] = Math.max(widths[c], i[c].length);
        });
    });

    var template = '';
    columns.forEach(function (c) {
        template += '%-' + String(widths[c]) + 's  ';
    });
    template = template.trim();

    if (sort.length) {
        function cmp(a, b) {
          for (var i = 0; i < sort.length; i++) {
            var field = sort[i];
            var invert = false;
            if (field[0] === '-') {
                invert = true;
                field = field.slice(1);
            }
            assert.ok(field.length, 'zero-length sort field: ' + options.sort);
            if (a[field] < b[field]) {
                return (invert ? 1 : -1);
            } else if (a[field] > b[field]) {
                return (invert ? -1 : 1);
            }
          }
          return 0;
        }
        items.sort(cmp);
    }

    if (!options.skipHeader) {
        var header = columns.map(function (c) { return c.toUpperCase(); });
        header.unshift(template);
        console.log(sprintf.apply(null, header));
    }
    items.forEach(function (i) {
        var row = columns.map(function (c) {
            var cell = i[c];
            if (cell === null || cell === undefined) {
                return '-';
            } else {
                return String(i[c]);
            }
        });
        row.unshift(template)
        console.log(sprintf.apply(null, row));
    })
}


CLI.prototype.do_listimages = function do_listimages(subcmd, opts, args, callback) {
    var self = this;
    this.client.listImages(function (err, images, res) {
        self.log.trace({err: err, res: res}, 'ping');
        if (err) {
            return callback(new errors.APIError(err))
        }
        if (opts.json) {
            console.log(JSON.stringify(images, null, 2));
        } else {
            images.forEach(function (i) {
                if (i.published_at)
                    i.published = i.published_at.slice(0, 10);
            });
            try {
                tabulate(images, {
                    skipHeader: opts.skipHeader,
                    columns: opts.output || 'uuid,name,os,state,published',
                    sort: opts.sort || 'published,name',
                    validFields: 'uuid,owner,name,state,disabled,public,published,published_at,type,os'
                });
            } catch (e) {
                callback(e);
            }
        }
    });
};
CLI.prototype.do_listimages.description = (
    'List images.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME listimages [OPTIONS]\n' +
    '\n' +
    'Options:\n' +
    '    -j, --json         JSON output'
);
CLI.prototype.do_listimages.longOpts = {
    'json': Boolean,
    'skipHeader': Boolean,
    'output': String,
    'sort': String
};
CLI.prototype.do_listimages.shortOpts = {
    'j': ['--json'],
    'H': ['--skipHeader'],
    'o': ['--output'],
    's': ['--sort']
};



//---- exports

module.exports = CLI;
