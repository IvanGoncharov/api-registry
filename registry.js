#!/usr/bin/env node
// @ts-check

const fs = require('fs');
const path = require('path');
const url = require('url');

const deepmerge = require('deepmerge');
const fetch = require('fetch-filecache-for-crawling');
const mkdirp = require('mkdirp');
const s2o = require('swagger2openapi');
const validator = require('oas-validator');
const yaml = require('yaml');

const ng = require('./index.js');

const logoPath = path.resolve('.','deploy','v2','cache','logo');
const logoCache = path.resolve('.','metadata','logo.cache');
const mainCache = path.resolve('.','metadata','main.cache');

const argv = require('tiny-opts-parser')(process.argv);
const resOpt = { resolve: true };
const valOpt = { patch: true, validateSchema: 'never', resolve: false };

//Disable check of SSL certificates
//process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

async function validateObj(o,s,candidate) {
  valOpt.text = s;
  valOpt.source = candidate.md.source.url;
  let result = { valid: false };
  try {
    if (o.swagger && o.swagger == '2.0') {
      process.stdout.write('c');
      await s2o.convertObj(o, valOpt);
      o = valOpt.openapi;
    }
    process.stdout.write('v');
    await validator.validate(o, valOpt);
    result = valOpt;
    if (!result.valid) throw new Error('Validation failure');
  }
  catch (ex) {
    console.log();
    console.warn(ng.colour.red+ex.message+ng.colour.normal);
    if (valOpt.context) {
      console.warn(ng.colour.red+valOpt.context.pop()+ng.colour.normal);
    }
  }
  console.log('',result.valid ? ng.colour.green+'✔' : ng.colour.red+'✗',ng.colour.normal);
  candidate.md.valid = result.valid;
  return result.valid;
}

async function fix(candidate, o) {
  // TODO use jmespath queries to fix up stuff
}

const commands = {
  populate: async function(candidate) {
    console.log('pop');
    return true;
  },
  git: async function(candidate) {
    const dates = ng.exec(`git log --format=%aD --follow -- '${candidate.md.filename}'`).toString().split('\n');
    candidate.md.added = new Date(dates[dates.length-2]);
    candidate.md.updated = new Date(dates[0]);
    console.log('git');
    return true;
  },
  rewrite: async function(candidate) {
    let s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    fs.writeFileSync(candidate.md.filename,yaml.stringify(o),'utf8');
    console.log('rw');
  },
  cache: async function(candidate) {
    let s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    const origin = o.info['x-origin'];
    const source = origin.pop();

    source.url = source.url.replace('https://raw.githubusercontent.com/NYTimes/public_api_specs/master','../cache/nytimes.com/public_api_specs-master');
    source.url = source.url.replace('https://raw.githubusercontent.com/Azure/azure-rest-api-specs/master','../cache/azure.com/azure-rest-api-specs-master');
    source.url = source.url.replace('file://localhost/','');

    origin.push(source);
    fs.writeFileSync(candidate.md.filename,yaml.stringify(o),'utf8');
    console.log('cache');
  },
  deploy: async function(candidate) {
    let s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    const defaultLogo = 'https://apis.guru/assets/images/no-logo.svg';
    let origLogo = defaultLogo;
    if ((o.info['x-logo']) && (o.info['x-logo'].url)) {
      origLogo = o.info['x-logo'].url;
    }
    let response;
    try {
      const res = await fetch(origLogo, {cacheFolder: logoCache});
      response = await res.buffer();
    }
    catch (ex) {
      console.warn(ex.message);
      const res = await fetch(defaultLogo, {cacheFolder: logoCache});
      response = await res.buffer();
    }
    const logoName = origLogo.split('://').join('_').split('/').join('_').split('?')[0];
    if (response.body) {
      fs.writeFileSync(path.join(logoPath,logoName),response.body);
    }

    if (!o.info['x-logo']) o.info['x-logo'] = {};
    o.info['x-logo'].url = 'https://api.apis.guru/v2/cache/logo/'+logoName;

    s = yaml.stringify(o);
    const j = JSON.stringify(o,null,2);
    const filename = candidate.md.openapi.startsWith('3.') ? 'openapi.' : 'swagger.';
    let filepath = path.resolve('.','deploy','v2','specs');
    filepath = path.join(filepath,candidate.provider,candidate.service,candidate.version);
    await mkdirp(filepath);
    fs.writeFileSync(path.join(filepath,filename+'yaml'),s,'utf8');
    fs.writeFileSync(path.join(filepath,filename+'json'),j,'utf8');
    console.log('deploy');
    return true;
  },
  validate: async function(candidate) {
    const s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    return await validateObj(o,s,candidate);
  },
  update: async function(candidate) {
    const u = candidate.md.source.url;
    if (!u) throw new Error('No url');
    if (candidate.driver === 'external') return true;
    // TODO github, google, apisjson etc
    try {
      let s;
      if (u.startsWith('http')) {
        process.stdout.write('f');
        const response = await fetch(u, {logToConsole:false, cacheFolder: mainCache});
        if (response.ok) {
          s = await response.text();
        }
      }
      else if (u.startsWith('file')) {
        const filename = url.fileURLToPath(u);
        s = fs.readFileSync(filename,'utf8');
      }
      else {
        s = fs.readFileSync(u,'utf8');
      }
      let o = yaml.parse(s);
      if (o.info && o.info.version !== candidate.version) {
        console.log('  Updated to',o.info.version);
        candidate.parent[o.info.version] = candidate.parent[candidate.version];
        delete candidate.parent[candidate.version];
        const ofname = candidate.md.filename;
        candidate.md.filename = candidate.md.filename.replace(candidate.version,o.info.version);
        const pathname = path.dirname(candidate.md.filename);
        mkdirp.sync(pathname);
        ng.exec('mv '+ofname+' '+candidate.md.filename);
      }
      const result = await validateObj(o,s,candidate);
      if (result) {
        o = deepmerge(candidate.md.patch,o);
        delete o.info.logo; // TODO nytimes hack (masked by conv stage)
        if (o.info['x-apisguru-categories']) {
          o.info['x-apisguru-categories'] = Array.from(new Set(o.info['x-apisguru-categories']));
        }
        o.info['x-providerName'] = candidate.provider;
        const origin = ng.clone(candidate.md.history);
        origin.push(candidate.md.source);
        o.info['x-origin'] = origin;
        if (candidate.service) o.info['x-serviceName'] = candidate.service;
        if (typeof candidate.md.preferred !== 'undefined') o.info['x-preferred'] = candidate.md.preferred;
        fs.writeFile(candidate.md.filename,yaml.stringify(ng.sortJson(o)),'utf8',function(err){
          if (err) console.warn(err);
        });
        candidate.md.updated = ng.now;
        delete candidate.md.statusCode;
      }
      else {
        return false;
      }
    }
    catch (ex) {
      if (ex.timings) delete ex.timings;
      console.warn(ex.message,ex.response ? ex.response.statusCode : '');
      console.warn(ex);
      if (ex.response) {
        candidate.md.statusCode = ex.response.statusCode;
      }
      return false;
    }
    return true;
  }
};

//function analyseOpt(options) { // show size of each bucket in oas-kit options
//  let result = {};
//  for (let p in options) {
//    let j = JSON.stringify(options[p]);
//    result[p] = j.length;
//  }
//  return result;
//}

async function main(command, pathspec) {
  ng.loadMetadata();
  const apis = await ng.gather(pathspec, argv.slow);
  console.log(Object.keys(apis).length,'APIs found');
  ng.populateMetadata(apis);
  ng.runDrivers();
  const candidates = ng.getCandidates();
  console.log(candidates.length,'candidates found');

  let count = 0;
  let oldProvider = '*';
  for (let candidate of candidates) {
    if (candidate.provider !== oldProvider) {
      valOpt.cache = {};
      oldProvider = candidate.provider;
    }
    process.stdout.write(candidate.provider+' '+candidate.driver+' '+candidate.service+' '+candidate.version+' ');
    await commands[command](candidate);
    delete valOpt.cache[valOpt.source];
    //let voa = analyseOpt(valOpt);
    //fs.writeFileSync('../valopt'+count+'.json',JSON.stringify(voa,null,2),'utf8');
    count++;
  }

  ng.saveMetadata();
  return candidates.length;
}

process.exitCode = 0;

let command = argv._[2];
if (!command) {
  console.warn('Usage: registry {command}, where {command} is one of:');
  console.warn(Object.keys(commands));
  process.exit(0);
}
if (command === 'deploy') {
  mkdirp.sync(logoPath);
}
let pathspec = argv._[3];
if (!pathspec) pathspec = path.resolve('.','APIs');

process.on('exit', function() {
  console.log('Exiting with',process.exitCode);
});

main(command, pathspec);

