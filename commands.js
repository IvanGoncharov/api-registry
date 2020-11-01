#!/usr/bin/env node
// @ts-check

'use strict';

const assert = require('assert');
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
const removeMarkdown = require('remove-markdown');
const j2x = require('jgexml/json2xml.js');
const shields = require('badge-maker').makeBadge;
const liquid = require('liquid');
const semver = require('semver');
const google = require('google-discovery-to-swagger');
const postman = require('postman2openapi');
const apib2swagger = require('apib2swagger');
const apiBlueprint = util.promisify(apib2swagger.convert);

const ng = require('./backend.js');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const bobwAgent = function(_parsedURL) {
  if (_parsedURL.protocol == 'http:') {
    return httpAgent;
  } else {
    return httpsAgent;
  }
};

const logoPath = path.resolve('.','deploy','v2','cache','logo');
const logoCache = path.resolve('.','metadata','logo.cache');
const mainCache = path.resolve('.','metadata','main.cache');

const liquidEngine = new liquid.Engine();

yaml.scalarOptions.str.fold.lineWidth = 0;

let oasCache = {};
const resOpt = { resolve: true, fatal: true, verbose: false, cache: oasCache, fetch:fetch, fetchOptions: { cacheFolder: mainCache, refresh: 'default' } };
const valOpt = { patch: true, warnOnly: true, anchors: true, laxurls: true, laxDefaults: true, validateSchema: 'never', resolve: false, cache: oasCache, fetch:fetch, fetchOptions: { cacheFolder: mainCache, refresh: 'default' } };
const dayMs = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds
let htmlTemplate;
let argv = {};

const template = function(templateString, templateVars) {
  // use this. for replaceable parameters
  return new Function("return `"+templateString +"`;").call(templateVars);
}

function getProvider(u, source) {
  const absUrl = new URL(u, source);
  const abs = absUrl.toString();
  let {subDomains, domain, topLevelDomains} = pd.parseDomain(
    pd.fromUrl(abs)
  );
  if (!domain) {
    domain = absUrl.host;
  }
  if (typeof domain === 'string') domain = domain.replace('api.','');
  if (topLevelDomains && topLevelDomains[0] === 'googleapis') {
    return 'googleapis.com'; // FIXME hard-coded
  }
  return domain+(topLevelDomains ? '.'+topLevelDomains.join('.') : '');
}

async function validateObj(o,s,candidate,source) {
  valOpt.text = s;
  let result = { valid: false };
  try {
    if (o.discoveryVersion) {
      ng.logger.prepend('C');
      o = google.convert(o);
      valOpt.openapi = o;
      valOpt.patches = 1; // force taking from valOpt.openapi
    }
    else if (o.info && o.info._postman_id) {
      ng.logger.prepend('C');
      s = s.split('{{server}}').join(argv.host);
      s = s.split('{{baseURL}}').join(argv.host);
      o = JSON.parse(postman.transpile(s,'json'));
      valOpt.openapi = o;
      valOpt.patches = 1; // force taking from valOpt.openapi
    }
    else { // $ref doesn't mean a JSON Reference in google discovery land
      ng.logger.prepend('R');
      await resolver.resolve(o,source,resOpt);
      o = resOpt.openapi;
    }
    if (o.swagger && o.swagger == '2.0') {
      ng.logger.prepend('C');
      await s2o.convertObj(o, valOpt);
      o = valOpt.openapi; // for tests below, we extract it from options outside this func
    }
    else {
      // TODO other formats
    }
    ng.logger.prepend('V');
    if (o.openapi) { // checking openapi property
      await validator.validate(o, valOpt);
      result = valOpt;
    }
    else if (o.asyncapi) {
      result.valid = true; // TODO validate asyncapi
    }
    if (!result.valid) throw new Error('Validation failure');
  }
  catch (ex) {
    ng.logger.log();
    ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
    if (argv.debug) ng.logger.warn(ex);
    let context;
    if (valOpt.context) {
      context = valOpt.context.pop();
      ng.logger.warn(ng.colour.red+context+ng.colour.normal);
    }
    ng.fail(candidate,null,ex,context);
  }
  ng.logger.log('',result.valid ? ng.colour.green+'✔' : ng.colour.red+'✗',ng.colour.normal);
  candidate.md.valid = result.valid;
  return result.valid;
}

async function fix(candidate, o) {
  // TODO use jmespath queries to fix up stuff
}

async function retrieve(u) {
  let response = { status: 599, ok: false };
  let s;
  let ok;
  if (u.startsWith('http')) {
    ng.logger.prepend('F');
    response = await fetch(u, {logToConsole: argv.verbose, timeout:5000, 'User-Agent': 'curl/7.68.0', accept: '*/*', agent:bobwAgent, cacheFolder: mainCache, refresh: 'default'});
    if ((typeof response.status === 'string') && (response.status.startsWith('200'))) {
      ok = true;
    }
    if (response.ok || ok) {
      s = await response.text();
      if (ok) {
        response = Object.assign({},response,{ ok: true, status: 200 });
      }
    }
  }
  else if (u.startsWith('file')) {
    ng.logger.prepend('L');
    const filename = url.fileURLToPath(u);
    s = fs.readFileSync(filename,'utf8');
    response.status = 200;
    response.ok = true;
  }
  else {
    ng.logger.prepend('L');
    s = fs.readFileSync(u,'utf8');
    response.status = 200;
    response.ok = true;
  }
  return { response, text:s }
}

async function getObjFromText(text, candidate) {
  if (text.startsWith('FORMAT: ')) {
    const result = await apiBlueprint(text,{});
    candidate.md.autoUpgrade = true;
    return result.swagger;
  }
  else return yaml.parse(text);
}

const commands = {
  populate: async function(candidate) {
    ng.logger.log('pop');
    return true;
  },
  git: async function(candidate) {
    const dates = ng.exec(`git log --format=%aD --follow -- '${candidate.md.filename}'`).toString().split('\n');
    candidate.md.added = new Date(dates[dates.length-2]);
    candidate.md.updated = new Date(dates[0]);
    ng.logger.log('git');
    return true;
  },
  urls: async function(candidate) {
    ng.logger.log();
    ng.logger.log('🔗 ',ng.colour.yellow+candidate.md.source.url+ng.colour.normal);
  },
  contact: async function(candidate) {
    ng.logger.log();
    if (candidate.info) {
      if (candidate.info.contact) {
        if (candidate.info.contact.name) {
          ng.logger.log('👤 ',ng.colour.yellow+candidate.info.contact.name+ng.colour.normal);
        }
        if (candidate.info.contact.url) {
          ng.logger.log('🔗 ',ng.colour.yellow+candidate.info.contact.url+ng.colour.normal);
        }
        if (candidate.info.contact.email) {
          ng.logger.log('📧 ',ng.colour.yellow+candidate.info.contact.email+ng.colour.normal);
        }
        if (candidate.info.contact['x-twitter']) {
          ng.logger.log('🐦 ',ng.colour.yellow+candidate.info.contact['x-twitter']+ng.colour.normal);
        }
      }
      if (candidate.info.license) {
        ng.logger.log('⚖ ',ng.colour.yellow+candidate.info.license.name+ng.colour.normal);
      }
      if (candidate.info['x-logo']) {
        ng.logger.log('🖼 ',ng.colour.yellow+candidate.info['x-logo'].url+ng.colour.normal);
      }
    }
  },
  '404': async function(candidate) {
    if (parseInt(candidate.md.statusCode,10) >= 400) {
      const patch = Object.assign({},candidate.parent.patch,candidate.gp.patch);
      let twitter = '';
      if (patch && patch.info && patch.info.contact && patch.info.contact["x-twitter"]) {
        twitter = '@'+patch.info.contact["x-twitter"];
      }
      ng.logger.log('🔗 ',ng.colour.red+candidate.md.source.url+ng.colour.normal,twitter);
    }
    else {
      ng.logger.prepend(ng.colour.clear);
    }
  },
  retry: async function(candidate) {
    if (parseInt(candidate.md.statusCode,10) >= 400) {
      await commands.update(candidate);
    }
    else {
      ng.logger.prepend(ng.colour.clear);
    }
  },
  rewrite: async function(candidate) {
    let s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    fs.writeFileSync(candidate.md.filename,yaml.stringify(o),'utf8');
    ng.logger.log('rw');
  },
  purge: async function(candidate) {
    if (!fs.existsSync(candidate.md.filename)) {
      ng.logger.log(ng.colour.yellow+'␡'+ng.colour.normal);
      delete candidate.parent[candidate.version];
    }
    else {
      ng.logger.log();
    }
  },
  endpoints: async function(candidate) {
    try {
      let s = fs.readFileSync(candidate.md.filename,'utf8');
      const o = yaml.parse(s);
      candidate.md.endpoints = Object.keys(o.paths||o.topics||{}).length;
      if (candidate.md.endpoints === 0) {
        fs.unlinkSync(candidate.md.filename);
        delete candidate.parent[candidate.version];
      }
      ng.logger.log(ng.colour.green+'p:'+candidate.md.endpoints,ng.colour.normal);
    }
    catch (ex) {
      ng.logger.log(ng.colour.red+ex.message,ng.colour.normal);
      ng.fail(candidate,null,ex,'endpoints');
    }
  },
  cache: async function(candidate) {
    let s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    const origin = o.info['x-origin'];
    const source = ng.clone(origin[origin.length-1]);

    source.url = source.url.replace('https://raw.githubusercontent.com/NYTimes/public_api_specs/master','./metadata/nytimes.com.cache/public_api_specs-master');
    source.url = source.url.replace('https://raw.githubusercontent.com/Azure/azure-rest-api-specs/master','./metadata/azure.com.cache/azure-rest-api-specs-master');
    source.url = source.url.replace('file://localhost/','');

    origin.push(source);
    fs.writeFileSync(candidate.md.filename,yaml.stringify(o),'utf8');
    candidate.md.history = ng.clone(origin);
    candidate.md.source = candidate.md.history.pop();
    ng.logger.log('cache');
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
        const res = await fetch(origLogo, {timeout:3500, agent:bobwAgent, cacheFolder: logoCache, refresh: 'never'});
        response = await res.buffer();
      }
      catch (ex) {
        colour = ng.colour.red;
        ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
        if (argv.debug) ng.logger.warn(ex);
        const res = await fetch(defaultLogo, {timeout:3500, agent:bobwAgent, cacheFolder: logoCache, refresh: 'never'});
        response = await res.buffer();
      }
      if (response) {
        fs.writeFileSync(logoFull,response);
      }
    }
    ng.logger.prepend(colour+'📷 '+ng.colour.normal);

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
    ng.logger.log(ng.colour.green+'✔'+ng.colour.normal);
    return true;
  },
  docs: async function(candidate) {
    let docpath = path.resolve('.','deploy','docs',candidate.provider,candidate.service);
    await mkdirp(docpath);
    docpath += '/'+candidate.version+'.html';
    const html = await htmlTemplate.render({ url: getApiUrl(candidate,'.json'), title: candidate.md.filename } );
    fs.writeFileSync(docpath,html,'utf8');
    ng.logger.log(ng.colour.green+'🗎'+ng.colour.normal);
  },
  validate: async function(candidate) {
    const s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    return await validateObj(o,s,candidate,candidate.md.filename);
  },
  ci: async function(candidate) {
    const diff = Math.round(Math.abs((ng.now - new Date(candidate.md.updated)) / dayMs));
    if (diff <= 1.1) {
      const s = fs.readFileSync(candidate.md.filename,'utf8');
      const o = yaml.parse(s);
      return await validateObj(o,s,candidate,candidate.md.filename);
    }
    else {
      ng.logger.log(ng.colour.yellow+'🕓'+ng.colour.normal);
    }
  },
  check: async function(u, metadata) {
    ng.logger.prepend(u+' ');
    try {
      const result = await retrieve(u);
      if (result.response.ok) {
        const candidate = { md: { source: { url: u }, valid: false } };
        let o = await getObjFromText(result.text, candidate);
        const org = o;
        const valid = await validateObj(o,result.text,candidate,candidate.md.source.url);
        ng.logger.log(valid);
      }
      else {
        ng.logger.warn(ng.colour.red,result.response.status,ng.colour.normal);
      }
    }
    catch (ex) {
      ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
      if (argv.debug) ng.logger.warn(ex);
    }
  },
  add: async function(u, metadata) {
    ng.logger.prepend(u+' ');
    try {
      const result = await retrieve(u);
      if (result.response.ok) {
        const candidate = { md: { source: { url: u }, valid: false } };
        let o = await getObjFromText(result.text, candidate);
        const org = o;
        const valid = await validateObj(o,result.text,candidate,candidate.md.source.url);
        if (valid || argv.force) {
          if ((valOpt.patches > 0) || candidate.md.autoUpgrade) {
            o = valOpt.openapi;
          }
          let ou = u;
          if (!o.host) {
            if (!o.servers) {
              o.servers = [];
            }
            if (argv.host) {
              let url = argv.host;
              if (!url.startsWith('http')) {
                url = 'http://'+argv.host; // not https as likely a .local placeholder
              }
              o.servers.unshift({ url: url });
            }
            ou = o.servers[0].url;
          }
          if (o.host) {
            if (argv.host) o.host = argv.host;
            ou = o.host;
          }

          if (argv.logo) {
            if (!o.info['x-logo']) {
              o.info['x-logo'] = {};
            }
            o.info['x-logo'].url = argv.logo;
          }
          if ((o.info['x-logo']) && (o.info['x-logo'].url)) {
            let colour = ng.colour.red;
            try {
              await fetch(o.info['x-logo'].url, {timeout:3500, agent:bobwAgent, cacheFolder: logoCache, refresh: 'once'});
              colour = ng.colour.green;
            }
            catch (ex) {}
            ng.logger.prepend(colour+'📷 '+ng.colour.normal);
          }

          const provider = getProvider(ou, u);
          assert.ok(provider,'Provider not defined');
          const service = argv.service || '';

          if (!metadata[provider]) {
            metadata[provider] = { driver: 'url', apis: {} };
          }
          if (!metadata[provider].apis[service]) {
            metadata[provider].apis[service] = {};
          }
          candidate.parent = metadata[provider].apis[service];
          candidate.gp = metadata[provider];
          candidate.md.added = ng.now;
          candidate.md.updated = ng.now;
          candidate.md.history = [];
          if (org.openapi) {
            candidate.md.name = 'openapi.yaml';
            candidate.md.source.format = 'openapi';
            candidate.md.source.version = semver.major(org.openapi)+'.'+semver.minor(org.openapi);
            candidate.md.openapi = org.openapi;
          }
          else if (org.swagger) {
            if (o.openapi) {
              candidate.md.name = 'openapi.yaml';
            }
            else {
              candidate.md.name = 'swagger.yaml';
            }
            candidate.md.source.format = 'swagger';
            candidate.md.source.version = org.swagger;
            candidate.md.openapi = o.openapi ? o.openapi : o.swagger;
          }
          else if (org.asyncapi) {
            candidate.md.name = 'asyncapi.yaml';
            candidate.md.source.format = 'asyncapi';
            candidate.md.source.version = semver.major(org.asyncapi)+'.'+semver.minor(org.asyncapi);
            candidate.md.asyncapi = org.asyncapi;
          }
          else if (org.discoveryVersion) {
            candidate.md.name = 'openapi.yaml';
            candidate.md.source.format = 'google';
            candidate.md.source.version = org.discoveryVersion;
            candidate.md.openapi = o.openapi;
          }
          else if (org.info && org.info._postman_id) {
            candidate.md.name = 'openapi.yaml';
            candidate.md.source.format = 'postman';
            candidate.md.source.version = '2.x';
            candidate.md.openapi = o.openapi;
          }
          if (o.info && o.info.version === '') {
            o.info.version = '1.0.0';
          }
          metadata[provider].apis[service][o.info.version] = candidate.md;

          const filepath = path.resolve('.','APIs',provider,service,o.info.version);
          await mkdirp(filepath);
          const filename = path.resolve(filepath,candidate.md.name);
          candidate.md.filename = path.relative('.',filename);

          o.info['x-providerName'] = provider;
          if (service) {
            o.info['x-serviceName'] = service;
          }
          if (argv.unofficial) {
            o.info['x-unofficialSpec'] = true;
          }
          if (!o.info['x-origin']) {
            o.info['x-origin'] = [];
          }
          o.info['x-origin'].push(candidate.md.source);

          o = deepmerge(o,candidate.gp.patch||{});

          const patch = {};
          if (argv.categories) {
            const categories = argv.categories.split(',');
            o.info['x-apisguru-categories'] = categories;
            if (!patch.info) patch.info = {};
            patch.info['x-apisguru-categories'] = categories;
          }
          if (argv.logo) {
            if (!patch.info) patch.info = {};
            patch.info['x-logo'] = o.info['x-logo'];
          }

          if (Object.keys(patch).length) {
            candidate.parent.patch = patch;
          }

          const content = yaml.stringify(ng.sortJson(o));
          candidate.md.hash = ng.sha256(content);
          candidate.md.endpoints = Object.keys(o.paths||o.topics||{}).length;
          fs.writeFileSync(filename,content,'utf8');
          ng.logger.log('Wrote new',provider,service||'-',o.info.version,'in OpenAPI',candidate.md.openapi,valid ? ng.colour.green+'✔' : ng.colour.red+'✗',ng.colour.normal);
        }
      }
      else {
        ng.logger.warn(ng.colour.red,result.response.status,ng.colour.normal);
      }
    }
    catch (ex) {
      ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
      if (argv.debug) ng.logger.warn(ex);
    }
  },
  update: async function(candidate) {
    const u = candidate.md.source.url;
    if (!u) throw new Error('No url');
    if (candidate.driver === 'external') return true;
    // TODO github etc
    try {
      const result = await retrieve(u);
      let o = {};
      let autoUpgrade = false;
      if (result && result.response.ok) {
        delete candidate.md.statusCode;
        const s = result.text;
        o = await getObjFromText(s, candidate);
        const valid = await validateObj(o,s,candidate,candidate.md.source.url);
        if (valid) {
          // TODO if there is a logo.url try and fetch/cache it (if changed?)

          if ((valOpt.patches > 0) || (candidate.md.autoUpgrade)) {
            // passed validation as OAS 3 but only by patching the source
            // therefore the original OAS 2 document might not be valid as-is
            o = valOpt.openapi;
            autoUpgrade = true;
          }

          if (o.info && (o.info.version === '')) {
            o.info.version = '1.0.0';
          }

          let openapiVer = (o.openapi ? o.openapi : o.swagger);
          if ((o.info && (o.info.version !== candidate.version)) || (openapiVer !== candidate.md.openapi)) {
            ng.logger.log('  Updated to',o.info.version,'in OpenAPI',openapiVer);
            if (o.info.version !== candidate.version) {
              candidate.parent[o.info.version] = candidate.parent[candidate.version];
              delete candidate.parent[candidate.version];
            }
            const ofname = candidate.md.filename;
            candidate.md.filename = candidate.md.filename.replace('/'+candidate.version+'/','/'+o.info.version+'/');
            if (o.openapi) {
              candidate.md.filename = candidate.md.filename.replace('swagger.yaml','openapi.yaml');
              candidate.md.name = 'openapi.yaml';
              candidate.md.source.format = 'openapi';
              candidate.md.source.version = semver.major(o.openapi)+'.'+semver.minor(o.openapi);
            }
            const pathname = path.dirname(candidate.md.filename);
            mkdirp.sync(pathname);
            if (ofname !== candidate.md.filename) {
              ng.exec("mv '"+ofname+"' '"+candidate.md.filename+"'"); // TODO use shelljs ?
            }
          }

          o = deepmerge(o,candidate.gp.patch||{});
          o = deepmerge(o,candidate.parent.patch||{});

          if (o.info['x-apisguru-categories']) {
            o.info['x-apisguru-categories'] = Array.from(new Set(o.info['x-apisguru-categories']));
          }
          o.info['x-providerName'] = candidate.provider;
          const origin = ng.clone(candidate.md.history);
          origin.push(candidate.md.source);
          o.info['x-origin'] = origin;
          if (candidate.service) o.info['x-serviceName'] = candidate.service;
          if (typeof candidate.md.preferred === 'boolean') o.info['x-preferred'] = candidate.md.preferred;
          if (candidate.md.unofficial) o.info['x-unofficialSpec'] = true;
          const content = yaml.stringify(ng.sortJson(o));
          fs.writeFile(candidate.md.filename,content,'utf8',function(err){
            if (err) ng.logger.warn(err);
          });
          const newHash = ng.sha256(content);
          if (candidate.md.hash !== newHash) {
            candidate.md.hash = newHash;
            candidate.md.updated = ng.now;
          }
          candidate.md.endpoints = Object.keys(o.paths||o.topics||{}).length;
        }
        else { // if not valid
          return false;
        }
      }
      else { // if not status 200 OK
        candidate.md.statusCode = result.response.status;
        if (result.response.headers) {
          candidate.md.mediatype = result.response.headers.get('content-type');
        }
        ng.fail(candidate,result.response.status);
        ng.logger.log(ng.colour.red,result.response.status,ng.colour.normal);
        return false;
      }
    }
    catch (ex) {
      if (ex.timings) delete ex.timings;
      ng.logger.log();
      ng.logger.warn(ng.colour.red+ex.message,ex.response ? ex.response.statusCode : '',ng.colour.normal);
      if (argv.debug || !ex.message) ng.logger.warn(ex);
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

function rssFeed(data) {
  let feed = {};
  let rss = {};

  let d = ng.now;

  ng.logger.log('RSS Feed...');

  rss['@version'] = '2.0';
  rss["@xmlns:atom"] = 'http://www.w3.org/2005/Atom';
  rss.channel = {};
  rss.channel.title = 'APIs.guru OpenAPI directory RSS feed';
  rss.channel.link = 'https://api.apis.guru/v2/list.rss';
  rss.channel["atom:link"] = {};
  rss.channel["atom:link"]["@rel"] = 'self';
  rss.channel["atom:link"]["@href"] = rss.channel.link;
  rss.channel["atom:link"]["@type"] = 'application/rss+xml';
  rss.channel.description = 'APIs.guru OpenAPI directory RSS feed';
  rss.channel.webMaster = 'mike.ralphson@gmail.com (Mike Ralphson)';
  rss.channel.pubDate = ng.now.toUTCString();
  rss.channel.generator = 'openapi-directory https://github.com/apis-guru/openapi-directory';
  rss.channel.item = [];

  for (let api in data) {

      let p = data[api].versions[data[api].preferred];
      if (p && p.info) {
        let i = {};
        i.title = p.info.title;
        i.link = p.info["x-origin"][0].url;
        i.description = removeMarkdown(p.info.description ? p.info.description.trim().split('\n')[0] : p.info.title);
        i.category = 'APIs';
        i.guid = {};
        i.guid["@isPermaLink"] = 'false';
        i.guid[""] = api;
        i.pubDate = new Date(p.updated).toUTCString();

        if (p.info["x-logo"]) {
          i.enclosure = {};
          i.enclosure["@url"] = p.info["x-logo"].url;
          i.enclosure["@length"] = 15026;
          i.enclosure["@type"] = 'image/jpeg';
          if (typeof i.enclosure["@url"] === 'string') {
            let tmp = i.enclosure["@url"].toLowerCase();
            if (tmp.indexOf('.png')>=0) i.enclosure["@type"] = 'image/png';
            if (tmp.indexOf('.svg')>=0) i.enclosure["@type"] = 'image/svg+xml';
          }
          else ng.logger.warn(api,i.enclosure["@url"]);
        }

        rss.channel.item.push(i);
      }
  }

  feed.rss = rss;
  return j2x.getXml(feed,'@','',2);
}

function getApiUrl(candidate, ext) {
  let result = 'https://api.apis.guru/v2/specs/'+candidate.provider;
  if (candidate.service) result += '/' + candidate.service;
  result += '/' + candidate.version + '/' + (candidate.md.openapi.startsWith('3.') ? 'openapi' : 'swagger') + ext;
  return result;
}

function badges(metrics) {
  const badgepath = path.resolve('.','deploy','badges');
  ng.logger.log('Badges...');
  mkdirp.sync(badgepath);
  const badges = [
    { label: 'APIs in collection', name: 'apis_in_collection.svg', prop: 'numAPIs', color: 'orange' },
    { label: 'Endpoints', name: 'endpoints.svg', prop: 'numEndpoints', color: 'red' },
    { label: 'OpenAPI Specs', name: 'openapi_specs.svg', prop: 'numSpecs', color: 'yellow' },
    { label: '🐝 Tested on', name: 'tested_on.svg', prop: 'numSpecs', color: 'green' }
  ];
  for (let badge of badges) {
     const format = { label: badge.label, message: metrics[badge.prop].toString(), color: badge.color };
     // TODO logo when https://github.com/badges/shields/issues/4947 done
     const svg = shields(format);
     fs.writeFileSync(badgepath+'/'+badge.name,svg,'utf8');
  }
}

const startUp = {
  deploy: async function(candidates) {
    await mkdirp(logoPath);
  },
  docs: async function(candidates) {
    htmlTemplate = await liquidEngine.parse(fs.readFileSync(path.resolve(__dirname,'templates','redoc.html'),'utf8'));
  }
};

const wrapUp = {
  deploy: async function(candidates) {
    let totalEndpoints = 0;
    const list = {};

    ng.logger.log('API list...');

    for (let candidate of candidates) {
      totalEndpoints += candidate.md.endpoints;
      let key = candidate.provider;
      if (candidate.service) key += ':'+candidate.service;
      if (!list.key) list[key] = { added: candidate.md.added, preferred: candidate.version, versions: {} };
      list[key].versions[candidate.version] = { added: candidate.md.added, info: candidate.info, updated: candidate.md.updated, swaggerUrl: getApiUrl(candidate, '.json'), swaggerYamlUrl: getApiUrl(candidate,'.yaml'), openapiVer: candidate.md.openapi };
      if (candidate.preferred) list[key].preferred = candidate.version;
    }
    const metrics = {
      numSpecs: candidates.length,
      numAPIs: Object.keys(list).length,
      numEndpoints: totalEndpoints
    };
    badges(metrics);
    fs.writeFileSync(path.resolve('.','deploy','v2','list.json'),JSON.stringify(list,null,2),'utf8');
    fs.writeFileSync(path.resolve('.','deploy','v2','metrics.json'),JSON.stringify(metrics,null,2),'utf8');
    const xml = rssFeed(list);
    fs.writeFileSync(path.resolve('.','deploy','v2','list.rss'),xml,'utf8');
    fs.writeFileSync(path.resolve('.','deploy','.nojekyll'),'','utf8');
    try {
      const indexHtml = fs.readFileSync(path.resolve('.','metadata','index.html'),'utf8');
      fs.writeFileSync(path.resolve('.','deploy','index.html'),indexHtml,'utf8');
    }
    catch (ex) {
      ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
    }
  },
  docs: async function(candidates) {
    fs.writeFileSync(path.resolve('.','deploy','docs','index.html'),fs.readFileSync(path.resolve(__dirname,'templates','index.html'),'utf8'),'utf8');
  }
};

function analyseOpt(options) { // show size of each bucket in oas-kit options
  let result = {};
  for (let p in options) {
    let j = JSON.stringify(options[p]);
    result[p] = (typeof j === 'string' ? j.length : 0);
  }
  return result;
}

async function nop(p) {
  return p;
}

function registerCommand(cmd) {
  const newCmd = Object.assign({},{ pre: nop, run: nop, post: nop },cmd);
  startUp[cmd.name] = newCmd.pre;
  commands[cmd.name] = newCmd.run;
  wrapUp[cmd.name] = newCmd.post;
  return newCmd;
}

async function main(command, pathspec, options) {
  argv = options;
  const metadata = ng.loadMetadata();

  if ((command === 'add') || (command === 'check')) {
    await commands[command](pathspec, metadata);
    ng.saveMetadata(command);
    return 1;
  }

  if (!argv.driver) {
    const apis = await ng.gather(pathspec, command, argv);
    const len = Object.keys(apis).length;
    if (len) {
      ng.logger.log(len,'API files read');
    }
    ng.populateMetadata(apis, pathspec, argv);
  }
  const candidates = ng.getCandidates(argv);
  ng.logger.log(candidates.length,'candidates found');
  await ng.runDrivers(argv.driver);

  const leads = ng.trimLeads(candidates);
  if ((command === 'update') && (Object.keys(leads).length)) {
    for (let u in leads) {
      argv.service = leads[u];
      await commands.add(u, metadata);
    }
  }

  if (startUp[command]) {
    await startUp[command](candidates);
  }

  let count = 0;
  let oldProvider = '*';
  for (let candidate of candidates) {
    if (candidate.provider !== oldProvider) {
      oasCache = {};
      resOpt.cache = oasCache;
      valOpt.cache = oasCache;
      oldProvider = candidate.provider;
    }
    ng.logger.prepend(candidate.provider+' '+candidate.driver+' '+(candidate.service||'-')+' '+candidate.version+' ');
    await commands[command](candidate);
    //delete valOpt.cache[resOpt.source];

    //let voa = analyseOpt(valOpt);
    //fs.writeFileSync('./valopt'+count+'.json',JSON.stringify(voa,null,2),'utf8');
    count++;
  }

  if (wrapUp[command]) {
    await wrapUp[command](candidates);
  }

  ng.saveMetadata(command);
  return candidates.length;
}

module.exports = {
  commands,
  registerDriver: ng.registerDriver,
  registerCommand,
  main
};

