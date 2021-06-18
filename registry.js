#!/usr/bin/env node
// @ts-check

'use strict';

const path = require('path');

const cmd = require('./commands.js');

const argv = require('tiny-opts-parser')(process.argv);
if (argv.q) argv.quiet = argv.q;
if (argv.s) argv.service = argv.s;
if (argv.h) argv.host = argv.h;
if (argv.l) argv.logo = argv.l;
if (argv.t) argv.twitter = argv.t;
if (argv.c) argv.categories = argv.c;
if (argv.category) argv.categories = argv.category;
if (argv.f) argv.force = argv.f;
if (argv.d) argv.debug = argv.d;
if (argv.i) argv.issue = argv.i;
if (argv.u) argv.unofficial = argv.u;

let command = argv._[2];
if (!command) {
  console.warn('Usage: registry {command}, where {command} is one of:');
  console.warn(Object.keys(cmd.commands));
  process.exit(0);
}
let pathspec = argv._[3];
if (!pathspec) pathspec = path.relative('.','APIs');

process.on('exit', function() {
  console.log('Exiting with',process.exitCode);
});

cmd.main(command, pathspec, argv);

