#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2016 Joyent, Inc.
#

#
# Vars, Tools, Files, Flags
#
JS_FILES	:= $(shell find lib test -name '*.js' | grep -v '/tmp/')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf

include ./tools/mk/Makefile.defs


#
# Targets
#
.PHONY: all
all:
	npm install

.PHONY: test
test: | node_modules/.bin/tape
	node_modules/.bin/tape test/*.test.js

DISTCLEAN_FILES += node_modules


include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.targ
