#!/usr/bin/env node
// @ts-check

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');
const util = require('util');

const deepmerge = require('deepmerge');
const fetch = require('fetch-filecache-for-crawling');
const mkdirp = require('mkdirp');
const pd = require('parse-domain');
const s2o = require('swagger2openapi');
const resolver = require('oas-resolver');
const validator = require('oas-validator');
const yaml = require('yaml');

const ng = require('./index.js');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const logoPath = path.resolve('.','deploy','v2','cache','logo');
const logoCache = path.resolve('.','metadata','logo.cache');
const mainCache = path.resolve('.','metadata','main.cache');

const argv = require('tiny-opts-parser')(process.argv);
if (argv.q) argv.quiet = argv.q;
if (argv.s) argv.service = argv.s;
if (argv.h) argv.host = argv.h;
if (argv.t) argv.twitter = argv.t;
if (argv.c) argv.categories = argv.c;
if (argv.f) argv.force = argv.f;
if (argv.i) argv.issue = argv.i;

let oasCache = {};
const resOpt = { resolve: true, cache: oasCache };
const valOpt = { patch: true, warnOnly: true, anchors: true, validateSchema: 'never', resolve: false, cache: oasCache };
const dayMs = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds

//Disable check of SSL certificates
//process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

function agent(url) {
  if (url.startsWith('https')) return httpsAgent;
  if (url.startsWith('http')) return httpAgent;
  return undefined;
}

function getProvider(u) {
  const {subDomains, domain, topLevelDomains} = pd.parseDomain(
    pd.fromUrl(u)
  );
  return domain+'.'+topLevelDomains.join('.');
}

async function validateObj(o,s,candidate) {
  valOpt.text = s;
  let result = { valid: false };
  try {
    valOpt.source = candidate.md.source.url;
    process.stdout.write('R');
    await resolver.resolve(o,valOpt.source,valOpt);
    o = valOpt.openapi;
    valOpt.resolve = false;
    if (o.swagger && o.swagger == '2.0') {
      process.stdout.write('C');
      await s2o.convertObj(o, valOpt);
      o = valOpt.openapi; //? working?
    }
    else {
      resOpt.source = candidate.md.source.url;
    }
    process.stdout.write('V');
    await validator.validate(o, valOpt);
    result = valOpt;
    if (!result.valid) throw new Error('Validation failure');
  }
  catch (ex) {
    console.log();
    console.warn(ng.colour.red+ex.message+ng.colour.normal);
    //console.warn(ex);
    let context;
    if (valOpt.context) {
      context = valOpt.context.pop();
      console.warn(ng.colour.red+context+ng.colour.normal);
    }
    ng.fail(candidate,null,ex,context);
  }
  console.log('',result.valid ? ng.colour.green+'✔' : ng.colour.red+'✗',ng.colour.normal);
  candidate.md.valid = result.valid;
  return result.valid;
}

async function fix(candidate, o) {
  // TODO use jmespath queries to fix up stuff
}

async function retrieve(u) {
  let response = { status: 599, ok: false };
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
    response.ok = true;
  }
  else {
    s = fs.readFileSync(u,'utf8');
    response.status = 200;
    response.ok = true;
  }
  return { response, text:s }
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
    let colour = ng.colour.green;
    if (!fs.existsSync(logoFull)) { // if we have not deployed this logo yet
      let response;
      try {
        const res = await fetch(origLogo, {timeout:1000, cacheFolder: logoCache, refresh: 'never'}); // TODO removed agent for now because of scheme changes on redirects
        response = await res.buffer();
      }
      catch (ex) {
        colour = ng.colour.red;
        console.warn(ng.colour.red+ex.message+ng.colour.normal);
        //console.warn(ex);
        const res = await fetch(defaultLogo, {timeout:1000, agent:agent(defaultLogo), cacheFolder: logoCache, refresh: 'never'});
        response = await res.buffer();
      }
      if (response) {
        fs.writeFileSync(logoFull,response);
      }
    }
    process.stdout.write(colour+'📷'+ng.colour.normal);

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
  ci: async function(candidate) {
    const diff = Math.round(Math.abs((ng.now - new Date(candidate.md.updated)) / dayMs));
    if (diff <= 2.0) {
      const s = fs.readFileSync(candidate.md.filename,'utf8');
      const o = yaml.parse(s);
      return await validateObj(o,s,candidate);
    }
    else {
      console.log(ng.colour.yellow+'🕓'+ng.colour.normal);
    }
  },
  add: async function(u,metadata) {
    process.stdout.write(u+' ');
    try {
      const result = await retrieve(u);
      if (result.response.ok) {
        let o = yaml.parse(result.text);
        const org = o;
        const candidate = { md: { source: { url: u }, valid: false } };
        const valid = await validateObj(o,result.text,candidate);
        if (valid) {
          if (valOpt.patches > 0) {
            o = valOpt.openapi;
          }
          let ou = u;
          if (o.servers) {
            ou = o.servers[0].url;
          }
          if (o.host) {
            ou = o.host;
          }
          const provider = getProvider(ou);
          const service = argv.service || '';

          if (!metadata[provider]) {
            metadata[provider] = { driver: 'url', apis: {} };
          }
          if (!metadata[provider].apis[service]) {
            metadata[provider].apis[service] = {};
          }
          candidate.md.added = ng.now;
          candidate.md.updated = ng.now;
          candidate.md.history = [];
          if (org.openapi) {
            candidate.md.name = 'openapi.yaml';
            candidate.md.source.format = 'openapi';
            candidate.md.source.version = org.openapi.substr(0,3); // TODO FIXME properly
            candidate.md.openapi = org.openapi;
          }
          else if (org.swagger) {
            candidate.md.name = 'swagger.yaml';
            candidate.md.source.format = 'swagger';
            candidate.md.source.version = org.swagger;
            candidate.md.openapi = o.openapi ? o.openapi : o.swagger;
          }
          if (o.info && o.info.version === '') {
            o.info.version = '1.0.0';
          }
          metadata[provider].apis[service][o.info.version] = candidate.md;

          const filepath = path.resolve('.','APIs',provider,service,o.info.version);
          await mkdirp(filepath);
          const filename = path.resolve(filepath,candidate.md.name);
          candidate.md.filename = path.relative('.',filepath);

          o.info['x-providerName'] = provider;
          if (service) {
            o.info['x-serviceName'] = service;
          }
          if (!o.info['x-origin']) {
            o.info['x-origin'] = [];
          }
          o.info['x-origin'].push(candidate.md.source);

          const patch = {};
          if (argv.categories) {
            const categories = argv.categories.split(',');
            o.info['x-apisguru-categories'] = categories;
            if (!patch.info) patch.info = {};
            patch.info['x-apisguru-categories'] = categories;
          }
          if (Object.keys(patch).length) {
            candidate.md.patch = patch;
          }

          const content = yaml.stringify(ng.sortJson(o));
          candidate.md.hash = ng.sha256(content);
          fs.writeFileSync(filename,content,'utf8');
          console.log('Wrote new',provider,service||'-',o.info.version,'in OpenAPI',candidate.md.openapi,valid ? ng.colour.green+'✔' : ng.colour.red+'✗',ng.colour.normal);
        }
      }
      else {
        console.warn(ng.colour.red,result.response.status,ng.colour.normal);
      }
    }
    catch (ex) {
      console.warn(ng.colour.red+ex.message+ng.colour.normal);
      //console.warn(ex);
    }
  },
  update: async function(candidate) {
    const u = candidate.md.source.url;
    if (!u) throw new Error('No url');
    if (candidate.driver === 'external') return true;
    // TODO github, google, apisjson etc
    try {
      const result = await retrieve(u);
      let o = {};
      let autoUpgrade = false;
      if (result && result.response.ok) {
        const s = result.text;
        o = yaml.parse(s);
        const valid = await validateObj(o,s,candidate);
        if (valid) {
          if (o.info && o.info.version === '') {
            o.info.version = '1.0.0';
          }

          if ((valOpt.patches > 0) || (candidate.md.autoUpgrade)) {
            // passed validation as OAS 3 but only by patching the source
            // therefore the original OAS 2 document might not be valid as-is
            o = valOpt.openapi;
            autoUpgrade = true;
          }

          let openapiVer = (o.openapi ? o.openapi : o.swagger);
          if (o.info && (o.info.version !== candidate.version) || (openapiVer !== candidate.md.openapi)) {
            console.log('  Updated to',o.info.version,openapiVer);
            if (o.info.version !== candidate.version) {
              candidate.parent[o.info.version] = candidate.parent[candidate.version];
              delete candidate.parent[candidate.version];
            }
            // TODO update metadata source
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
        ng.fail(candidate,response.status);
        console.log(ng.colour.red,response.status,ng.colour.normal);
        return false;
      }
    }
    catch (ex) {
      if (ex.timings) delete ex.timings;
      console.log();
      console.warn(ng.colour.red+ex.message,ex.response ? ex.response.statusCode : '',ng.colour.normal);
      //console.warn(ex);
      if (!ex.message) console.warn(ex);
      let r = ex.response;
      if (r) {
        candidate.md.statusCode = r.status;
        if (r.headers) {
          candidate.md.mediatype = r.headers.get('content-type');
        }
      }
      ng.fail(candidate,r ? r.status : undefined, ex, candidate.md.mediatype);
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
  const metadata = ng.loadMetadata();

  if (command === 'add') {
    await commands[command](pathspec,metadata);
    ng.saveMetadata();
    return 1;
  }

  if (!argv.only) {
    const apis = await ng.gather(pathspec, command, argv.patch);
    console.log(Object.keys(apis).length,'APIs scanned');
    ng.populateMetadata(apis);
  }
  ng.runDrivers(argv.only);
  const candidates = ng.getCandidates(argv.only, ng.fastCommand(command));
  console.log(candidates.length,'candidates found');

  let count = 0;
  let oldProvider = '*';
  for (let candidate of candidates) {
    if (candidate.provider !== oldProvider) {
      oasCache = {};
      resOpt.cache = oasCache;
      valOpt.cache = oasCache;
      oldProvider = candidate.provider;
    }
    process.stdout.write(candidate.provider+' '+candidate.driver+' '+candidate.service+' '+candidate.version+' ');
    await commands[command](candidate);
    //delete valOpt.cache[resOpt.source];
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

