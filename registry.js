#!/usr/bin/env node
// @ts-check

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');

const deepmerge = require('deepmerge');
const fetch = require('fetch-filecache-for-crawling');
const mkdirp = require('mkdirp');
const s2o = require('swagger2openapi');
const validator = require('oas-validator');
const yaml = require('yaml');

const ng = require('./index.js');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const logoPath = path.resolve('.','deploy','v2','cache','logo');
const logoCache = path.resolve('.','metadata','logo.cache');
const mainCache = path.resolve('.','metadata','main.cache');

const argv = require('tiny-opts-parser')(process.argv);
const resOpt = { resolve: true };
const valOpt = { patch: true, anchors: true, validateSchema: 'never', resolve: false };

//Disable check of SSL certificates
//process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

function agent(url) {
  if (url.startsWith('https')) return httpsAgent;
  if (url.startsWith('http')) return httpAgent;
  return undefined;
}

async function validateObj(o,s,candidate) {
  valOpt.text = s;
  valOpt.source = candidate.md.source.url;
  let result = { valid: false };
  try {
    if (o.swagger && o.swagger == '2.0') {
      process.stdout.write('C');
      await s2o.convertObj(o, valOpt);
      o = valOpt.openapi;
    }
    process.stdout.write('V');
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
  urls: async function(candidate) {
    console.log();
    console.log(ng.colour.yellow+candidate.md.source.url+ng.colour.normal);
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
    const logoName = origLogo.split('://').join('_').split('/').join('_').split('?')[0];
    const logoFull = path.join(logoPath,logoName);
    if (!fs.existsSync(logoFull)) { // if we have not deployed this logo yet
      let response;
      try {
        const res = await fetch(origLogo, {timeout:1000, cacheFolder: logoCache, refresh: 'never'}); // TODO removed agent for now because of scheme changes on redirects
        response = await res.buffer();
      }
      catch (ex) {
        console.warn(ng.colour.red+ex.message+ng.colour.normal);
        const res = await fetch(defaultLogo, {timeout:1000, agent:agent(defaultLogo), cacheFolder: logoCache, refresh: 'never'});
        response = await res.buffer();
      }
      if (response) {
        fs.writeFileSync(logoFull,response);
      }
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
    console.log(ng.colour.green+'✔'+ng.colour.normal);
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
    let response = { status: 599 };
    try {
      let s;
      if (u.startsWith('http')) {
        process.stdout.write('F');
        response = await fetch(u, {timeout:1000, agent:agent(u), logToConsole:false, cacheFolder: mainCache, refresh: 'once'});
        if (response.ok) {
          s = await response.text();
        }
      }
      else if (u.startsWith('file')) {
        const filename = url.fileURLToPath(u);
        s = fs.readFileSync(filename,'utf8');
        response.status = 200;
      }
      else {
        s = fs.readFileSync(u,'utf8');
      }
      let o = {};
      if (response.status === 200) {
        o = yaml.parse(s);
        const result = await validateObj(o,s,candidate);
        if (result) {
          if (o.info && o.info.version === '') {
            o.info.version = '1.0.0';
          }
          if (o.info && o.info.version !== candidate.version) {
            console.log('  Updated to',o.info.version);
            candidate.parent[o.info.version] = candidate.parent[candidate.version];
            delete candidate.parent[candidate.version];
            const ofname = candidate.md.filename;
            candidate.md.filename = candidate.md.filename.replace(candidate.version,o.info.version);
            if (o.openapi) candidate.md.filename = candidate.md.filename.replace('swagger.yaml','openapi.yaml');
            const pathname = path.dirname(candidate.md.filename);
            mkdirp.sync(pathname);
            ng.exec('mv '+ofname+' '+candidate.md.filename);
          }
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
          if (typeof candidate.md.preferred === 'boolean') o.info['x-preferred'] = candidate.md.preferred;
          const content = yaml.stringify(ng.sortJson(o));
          fs.writeFile(candidate.md.filename,content,'utf8',function(err){
            if (err) console.warn(err);
          });
          const newHash = ng.sha256(content);
          if (candidate.md.hash !== newHash) {
            candidate.md.hash = newHash;
            candidate.md.updated = ng.now;
          }
          delete candidate.md.statusCode;
        }
        else { // if not valid
          return false;
        }
      }
      else { // if not status 200 OK
        console.log(ng.colour.red,response.status,ng.colour.normal);
        console.log();
        return false;
      }
    }
    catch (ex) {
      if (ex.timings) delete ex.timings;
      console.log();
      console.warn(ng.colour.red+ex.message,ex.response ? ex.response.statusCode : '',ng.colour.normal);
      if (!ex.message) console.warn(ex);
      let r = ex.response || response;
      if (r) {
        console.log(r);
        candidate.md.statusCode = r.status;
        if (r.headers) {
          candidate.md.mediatype = r.headers.get('content-type');
        }
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
  if (!argv.only) {
    const apis = await ng.gather(pathspec, argv.patch);
    console.log(Object.keys(apis).length,'APIs found');
    ng.populateMetadata(apis);
  }
  ng.runDrivers(argv.only);
  const candidates = ng.getCandidates(argv.only);
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

