/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * The main entry point for an imgapi-cli instance.
 */

var util = require('util'),
    format = util.format;
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var assert = require('assert-plus');
var nopt = require('nopt');
var sprintf = require('extsprintf').sprintf;
var imgapi = require('sdc-clients/lib/imgapi');
var bunyan = require('bunyan');
var ProgressBar = require('progress');

var common = require('./common'),
    objCopy = common.objCopy;
var errors = require('./errors');



//---- internal support stuff

var DEFAULT_IDENTITY_FILES = [
    path.resolve(process.env.HOME, '.ssh/id_rsa')
];


var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function assertUuid(uuid) {
    if (!UUID_RE.test(uuid)) {
        throw new errors.InvalidUUIDError(uuid);
    }
}


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

    if (items.length === 0) {
        return;
    }

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
            widths[c] = Math.max(widths[c], (i[c] ? i[c].length : 0));
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
 * @param callback {Function} `function (err, verbose)`
 *      Where `verbose` is a boolean indicating if verbose output was
 *      requested by user options.
 */
CLI.prototype.main = function main(argv, callback) {
    var self = this;
    this.handleArgv(argv, this.envopts, function (err, opts) {
        if (err) {
            return callback(err);
        }

        var verbose = Boolean(opts.debug);
        var args = opts.argv.remain;
        if (opts.version) {
            console.log(self.name + ' ' + common.getVersion());
            return callback(null, verbose);
        }
        if (args.length === 0) {
            return self.printHelp(function (err) { callback(err, verbose) });
        } else if (opts.help) {
            // We want `cli foo -h` to show help for the 'foo' subcmd.
            if (args[0] !== 'help') {
                return self.do_help(args[0], opts, args, callback);
            }
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
        try {
            self.dispatch(subcmd, argv,
                function (err) { callback(err, verbose); });
        } catch (ex) {
            callback(ex, verbose);
        }
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
        if (func.hidden) {
            return;
        }
        var names = name;
        if (func.aliases) {
            names += sprintf(' (%s)', func.aliases.join(', '));
        }
        var desc = (func.description ?
            func.description.split('\n', 1)[0] : '');
        desc = desc.replace(/\$NAME/g, self.name);
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
    //      `joyent-imgadm -u trentm -j images`
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
    self.log.trace({opts: opts, argv: argv}, 'parsed subcmd argv');

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
        var desc = func.description.replace(/\$NAME/g, self.name).trimRight();
        console.log(desc);
        callback();
    } else {
        callback(new errors.ImgapiCliError(format('no help for "%s"', alias)));
    }
}
CLI.prototype.do_help.aliases = ['?'];
CLI.prototype.do_help.description = 'Give detailed help on a specific sub-command.';

CLI.prototype.help_help = function help_help(subcmd, callback) {
    this.printHelp(callback);
};


CLI.prototype._errorFromClientError = function _errorFromClientError(err) {
    assert.object(err, 'err');
    if (err.body && err.body.code) {
        return new errors.APIError(err);
    } else if (err.errno) {
        return new errors.ClientError(err);
    } else {
        return new errors.InternalError(err);
    }
}


CLI.prototype.do_ping = function do_ping(subcmd, opts, args, callback) {
    var self = this;
    if (args.length) {
        return callback(new errors.UsageError(
            'unexpected args: ' + args.join(' ')));
    }
    this.client.ping(function (err, pong, res) {
        self.log.trace({err: err, res: res}, 'Ping');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        console.log("pong");
        callback();
    });
};
CLI.prototype.do_ping.description = 'Ping the IMGAPI to see if it is up.';


CLI.prototype.do_state = function do_state(subcmd, opts, args, callback) {
    var self = this;
    if (args.length) {
        return callback(new errors.UsageError(
            'unexpected args: ' + args.join(' ')));
    }
    this.client.adminGetState(function (err, state, res) {
        self.log.trace({err: err, res: res}, 'AdminGetState');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        console.log(JSON.stringify(state, null, 2));
        callback();
    });
};
CLI.prototype.do_state.hidden = true;
CLI.prototype.do_state.description = (
    'Dump some IMGAPI internal state (for debugging).\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME state\n'
);


CLI.prototype.do_list = function do_list(subcmd, opts, args, callback) {
    var self = this;
    var filters = {};
    if (opts.all) {
        filters.state = 'all';
    }
    for (var i = 0; i < args.length; i++) {
        var arg = args[i];
        var idx = arg.indexOf('=');
        if (idx === -1) {
            return callback(new errors.UsageError(format(
                'invalid filter: "%s" (must be of the form "name=value")',
                arg)));
        }
        filters[arg.slice(0, idx)] = arg.slice(idx + 1);
    }
    this.client.listImages(filters, function (err, images, res) {
        self.log.trace({err: err, res: res}, 'ListImages');
        if (err) {
            return callback(self._errorFromClientError(err));
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
                return callback(e);
            }
            callback();
        }
    });
};
CLI.prototype.do_list.description = (
    'List images.\n' +
    '\n' +
    'For full details on filter fields, see\n' +
    '<https://mo.joyent.com/docs/imgapi/master/#ListImages>.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME list [OPTIONS] [FILTERS]\n' +
    '\n' +
    'Filters:\n' +
    '    FIELD=VALUE        Field equality filter. Supported fields: account,\n' +
    '                       owner, state, name, os, and type.\n' +
    '    FIELD=true|false   Field boolean filter. Supported fields: public.\n' +
    '    FIELD=~SUBSTRING   Field substring filter. Supported fields: name\n' +
    '\n' +
    'Filtering Options:\n' +
    '    -a, --all          List all images, not just "active" ones. This is\n' +
    '                       a shortcut for the "state=all" filter.\n' +
    '\n' +
    'Output Options:\n' +
    '    -j, --json         JSON output\n' +
    '    -H                 Do not print table header row\n' +
    '    -o field1,...      Specify fields (columns) to output. Default is\n' +
    '                       "uuid,name,os,state,published".\n' +
    '    -s field1,...      Sort on the given fields. Default is\n' +
    '                       "published,name".\n'
);
CLI.prototype.do_list.longOpts = {
    'json': Boolean,
    'skipHeader': Boolean,
    'output': String,
    'sort': String,
    'all': Boolean
};
CLI.prototype.do_list.shortOpts = {
    'j': ['--json'],
    'H': ['--skipHeader'],
    'o': ['--output'],
    's': ['--sort'],
    'a': ['--all']
};


CLI.prototype.do_get = function do_get(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);
    this.client.getImage(uuid, function (err, image, res) {
        self.log.trace({err: err, res: res}, 'GetImage');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        console.log(JSON.stringify(image, null, 2));
        callback();
    });
};
CLI.prototype.do_get.description = (
    'Get an image manifest.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME get UUID\n'
);
CLI.prototype.do_get.aliases = ['show', 'info'];


CLI.prototype.do_getfile = function do_getfile(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);
    assert.ok(!(opts.output && opts.outputUuidExt),
        'cannot use both "-o <file>" and "-O" options');

    function getOutputPath(next) {
        if (opts.output) {
            next(err, opts.output);
        } else if (opts.outputUuidExt) {
            self.client.getImage(uuid, function (imageErr, image, res) {
                if (imageErr)
                    return next(self._errorFromClientError(imageErr));
                var ext = "bz2";  // XXX Update this when have compression info!
                next(null, format("%s.%s", uuid, ext));
            });
        } else {
            next();  // undefined means <stdout>
        }
    }
    getOutputPath(function (pathErr, outputPath) {
        if (pathErr) {
            return callback(pathErr);
        }

        var bar = null;
        var hash = null;
        var md5Expected = null;
        var finished = false;
        function finish(err) {
            if (finished)
                return;
            finished = true;
            if (bar) {
                process.stderr.write('\n');
            }
            if (outputPath) {
                console.error('Saved "%s".', outputPath);
            }
            if (hash && !err) {
                assert.string(md5Expected, 'headers["Content-MD5"]');
                var md5Actual = hash.digest('base64');
                if (md5Actual !== md5Expected) {
                    err = new errors.DownloadError(format(
                        'Content-MD5 expected to be %s, but was %s',
                        md5Expected, md5Actual));
                }
            }
            callback(err);
        }

        self.client.getImageFileStream(uuid, function (err, stream) {
            self.log.trace({err: err, res: stream}, 'GetImageFileStream');
            if (!outputPath) {
                stream.pipe(process.stdout);
            } else {
                if (!opts.noProgress) {
                    bar = new ProgressBar(
                        ':percent [:bar]  time :elapseds  eta :etas',
                        {
                            complete: '=',
                            incomplete: ' ',
                            width: 30,
                            total: Number(stream.headers['content-length']),
                            stream: process.stderr
                        });
                }
                md5Expected = stream.headers['content-md5'];
                hash = crypto.createHash('md5');
                stream.on('data', function (chunk) {
                    if (bar)
                        bar.tick(chunk.length);
                    hash.update(chunk);
                });
                stream.pipe(fs.createWriteStream(outputPath));
            }
            stream.on('end', finish);
            stream.on('error', finish);
        });
    });
};
CLI.prototype.do_getfile.description = (
    'Get an image file.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME getfile [OPTIONS]\n' +
    '\n' +
    'Options:\n' +
    '    -o, --output <file>  Write output to <file>\n' +
    '    -O                   Write output to <UUID.EXT> where "EXT" is\n' +
    '                         appropriate for the image file\'s compression\n' +
    '    -P                   Disable download progress bar.'
);
CLI.prototype.do_getfile.longOpts = {
    'output': String,
    'outputUuidExt': Boolean,
    'noProgress': Boolean,
};
CLI.prototype.do_getfile.shortOpts = {
    'o': ['--output'],
    'O': ['--outputUuidExt'],
    'P': ['--noProgress']
};


CLI.prototype.do_delete = function do_delete(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);
    this.client.deleteImage(uuid, function (err, res) {
        self.log.trace({err: err, res: res}, 'DeleteImage');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        console.log('Deleted image %s', uuid);
        callback();
    });
};
CLI.prototype.do_delete.description = (
    'Delete an image.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME delete UUID\n'
);


CLI.prototype.do_create = function do_create(subcmd, opts, args, callback) {
    var self = this;
    if (args.length) {
        return callback(new errors.UsageError(
            'unexpected args: ' + args.join(' ')));
    }

    function getManifestData(next) {
        if (opts.manifest) {
            fs.readFile(opts.manifest, 'utf8', next);
        } else if (process.stdin.isTTY) {
            next(new errors.UsageError('image create: no manifest given'));
        } else {
            var data = '';
            finished = false;
            function finish(err) {
                if (finished)
                    return;
                finished = true;
                next(err, data);
            }
            process.stdin.resume();
            process.stdin.on('data', function (chunk) { data += chunk; });
            process.stdin.on('error', finish);
            process.stdin.on('end', finish);
        }
    }

    getManifestData(function (err, data) {
        if (err) {
            return callback(err);
        }
        try {
            var manifest = JSON.parse(data);
        } catch (syntaxErr) {
            return callback(new errors.InvalidManifestDataError(syntaxErr));
        }
        self.client.createImage(manifest, function (err, image, res) {
            self.log.trace({err: err, image: image, res: res}, 'CreateImage');
            if (err) {
                return callback(self._errorFromClientError(err));
            }
            console.log('Created image %s (state=%s)', image.uuid, image.state);
            if (!opts.file) {
                callback();
            } else {
                self.do_addfile('addfile', opts, [image.uuid], function (err2) {
                    if (err2) {
                        return callback(err2);
                    }
                    self.do_activate('activate', {}, [image.uuid], callback);
                });
            }
        });
    });
};
CLI.prototype.do_create.description = (
    'Create an image.\n' +
    '\n' +
    'This creates a new *unactivated* image with the given manifest data.\n' +
    'The typical next steps are to add the image file ($NAME addfile) then\n' +
    'activate the image ($NAME activate). All three steps can be done in\n' +
    'one by specifying the "-f FILE" option.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME create [-m MANIFEST-FILE]\n' +
    '    (manifest data on stdout) | $NAME create\n' +
    '\n' +
    'Options:\n' +
    '    -m MANIFEST-FILE   The manifest file with which to create\n' +
    '    -f FILE            Also upload the given file and activate the image\n' +
    '    -P                 Disable upload progress bar.\n'
);
CLI.prototype.do_create.longOpts = {
    'manifest': String,
    'file': String,
    'noProgress': Boolean
};
CLI.prototype.do_create.shortOpts = {
    'm': ['--manifest'],
    'f': ['--file'],
    'P': ['--noProgress']
};


CLI.prototype.do_addfile = function do_addfile(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);

    if (!opts.file) {
        return callback(new errors.UsageError('no image file path given'));
    }

    // TODO:XXX compression attribute: sniff by default, accept param
    function getFileInfo(next) {
        fs.stat(opts.file, function (statErr, stats) {
            if (statErr)
                return next(statErr);
            next(null, stats);
        });
    }

    getFileInfo(function (statErr, stats) {
        if (statErr) {
            return callback(statErr);
        }

        var stream = fs.createReadStream(opts.file);
        imgapi.pauseStream(stream);

        var bar;
        var sha1Hash = crypto.createHash('sha1');
        if (!opts.noProgress) {
            bar = new ProgressBar(
                ':percent [:bar]  time :elapseds  eta :etas',
                {
                    complete: '=',
                    incomplete: ' ',
                    width: 30,
                    total: stats.size,
                    stream: process.stderr
                });
        }
        stream.on('data', function (chunk) {
            if (bar)
                bar.tick(chunk.length);
            sha1Hash.update(chunk);
        })
        stream.on('end', function () {
            if (bar)
                process.stderr.write('\n');
        });

        self.client.addImageFile(uuid, stream, function (err, image, res) {
            self.log.trace({err: err, image: image, res: res}, 'AddImageFile');
            if (err) {
                return callback(self._errorFromClientError(err));
            }

            console.log('Added file "%s" to image %s', opts.file, uuid);

            // Verify uploaded size and sha1.
            if (sha1Hash) {
                var expectedSha1 = sha1Hash.digest('hex');
                if (expectedSha1 !== image.files[0].sha1) {
                    return callback(new errors.UploadError(format(
                        'sha1 expected to be %s, but was %s',
                        expectedSha1, image.files[0].sha1)));
                }
            }
            var expectedSize = stats.size;
            if (expectedSize !== image.files[0].size) {
                return callback(new errors.UploadError(format(
                    'size expected to be %s, but was %s',
                    expectedSize, image.files[0].size)));
            }

            callback();
        });
    });
};
CLI.prototype.do_addfile.description = (
    'Add an image file.\n' +
    '\n' +
    'Typically this is used to add the image file to a newly created image,\n' +
    '$NAME create. Then use `$NAME activate UUID` to activate the image.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME addfile [-f FILE] UUID\n' +
    '    (file data on stdout) | $NAME addfile UUID\n' +
    '\n' +
    'Options:\n' +
    '    -f <file>            Image file to add\n' +
    '    -P                   Disable progress bar.'
);
CLI.prototype.do_addfile.longOpts = {
    'file': String,
    'noProgress': Boolean,
};
CLI.prototype.do_addfile.shortOpts = {
    'f': ['--file'],
    'P': ['--noProgress']
};


CLI.prototype.do_activate = function do_activate(subcmd, opts, args, callback) {
    var self = this;
    if (args.length !== 1) {
        return callback(new error.UsageError(
            format('incorrect number of args (%d)', args.length)));
        return callback(new errors.UsageError(format(
            'incorrect number of args (%d): %s', args.length, args.join(' '))));
    }
    var uuid = args[0];
    assertUuid(uuid);

    self.client.activateImage(uuid, function (err, image, res) {
        self.log.trace({err: err, image: image, res: res}, 'ActivateImage');
        if (err) {
            return callback(self._errorFromClientError(err));
        }
        assert.equal(image.state, 'active');
        console.log('Activated image %s', uuid);
        callback();
    });
};
CLI.prototype.do_activate.description = (
    'Activate an image.\n' +
    '\n' +
    'The final step in making an image available for use is to activate it.\n' +
    'This is typically done after creation ($NAME create) and adding the\n' +
    'image file ($NAME addfile). Once active, an image cannot be \n' +
    'de-activated, only disabled, made private or deleted.\n' +
    '\n' +
    'Usage:\n' +
    '    $NAME activate UUID\n'
);



//---- exports

module.exports = CLI;
