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
const v8 = process.release.name === 'node' ? require('v8') : undefined;

const deepmerge = require('deepmerge');
const cfetch = require('fetch-filecache-for-crawling');
const mkdirp = require('mkdirp');
const pd = require('parse-domain');
const s2o = require('swagger2openapi');
const resolver = require('oas-resolver');
const validator = require('oas-validator');
const yml = require('yaml');
const removeMarkdown = require('remove-markdown');
const j2x = require('jgexml/json2xml.js');
const shields = require('badge-maker').makeBadge;
const liquid = require('liquid');
const semver = require('semver');
const google = require('google-discovery-to-swagger');
const postman = require('postman2openapi');
const postmanCT = require('postman-collection-transformer');
const postman1 = util.promisify(postmanCT.convert);
const fetchFavicon = require('@astridhq/fetch-favicon').fetchFavicon;
const betterLookup = require('better-lookup').lookup;
const cheerio = require('cheerio');

const ng = require('./backend.js');

const httpAgent = new http.Agent({ keepAlive: true, lookup: betterLookup });
const httpsAgent = new https.Agent({ keepAlive: true, lookup: betterLookup, rejectUnauthorized: false });
const bobwAgent = function(_parsedURL) {
  if (_parsedURL.protocol === 'http:') {
    return httpAgent;
  } else {
    return httpsAgent;
  }
};

const logoPath = path.resolve('.','deploy','v2','cache','logo');
const logoCache = path.resolve('.','metadata','logo.cache');
const mainCache = path.resolve('.','metadata','main.cache');

const oasDefaultVersion = '3.0.0';

const liquidEngine = new liquid.Engine();
const landingPages = new Map();

const newCandidates = [];

let oasCache = {};
const resOpt = { resolve: true, fatal: true, verbose: false, cache: oasCache, fetch:fetch, agent: bobwAgent, fetchOptions: { cacheFolder: mainCache, refresh: 'default' } };
const valOpt = { patch: true, repair: true, warnOnly: true, convWarn: [], anchors: true, laxurls: true, laxDefaults: true, laxScopes: false, validateSchema: 'never', resolve: false, cache: oasCache, fetch:fetch, fetchOptions: { cacheFolder: mainCache, refresh: 'default' } };
const dayMs = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds
const defaultVersion = '1.0.0';

let htmlTemplate, listTemplate;
let apiList = '';
let argv = {};
let iteration = 0;
let apib2swagger, apiBlueprint;

const template = function(templateString, templateVars) {
  // use this. for replaceable parameters
  return new Function("return `"+templateString +"`;").call(templateVars);
}

function majorMinor(version) {
  if (version === '2.0') version = '2.0.0';
  return `${semver.major(version)}.${semver.minor(version)}`;
}

async function slack(text) {
  if (process.env.SLACK_ALERT_URL) {
    await fetch(process.env.SLACK_ALERT_URL, {
      method: 'post',
      body:    JSON.stringify({ text }),
      headers: { 'Content-Type': 'application/json' },
      cacheFolder: path.resolve('.','metadata','webhook.cache')
    });
  }
}

function saveHeapSnapshot() {
  if (v8) {
    const snapshotStream = v8.getHeapSnapshot();
    // filename must end with `.heapsnapshot`, otherwise Chrome DevTools won't open it.
    const fileName = `./${Date.now()}.heapsnapshot`;
    const fileStream = fs.createWriteStream(fileName);
    snapshotStream.pipe(fileStream);
  }
}

function getServer(o, u) {
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
    assert.ok(o.servers[0],'Could not determine servers information');
    let ok = true;
    if (o.servers[0].url.indexOf('localhost')>=0) ok = false;
    if (o.servers[0].url.indexOf('githubusercontent')>=0) ok = false;
    assert.ok(ok,'Server must not be in blocklist');
    ou = o.servers[0].url;
  }
  if (o.host) {
    if (argv.host) o.host = argv.host;
    ou = o.host;
  }
  return ou;
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
    return 'googleapis.com'; // FIXME hard-coded to fit in with previous script behaviour
  }
  return domain+(topLevelDomains ? '.'+topLevelDomains.join('.') : '');
}

async function getSocial(candidate) {
  const url = 'https://'+candidate.provider;
  try {
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);
    const meta = {};
    $('meta').each(function() {
      const name = $(this).attr('name') || $(this).attr('property');
      const content = $(this).attr('content');
      if (name && content) {
        meta[name] = content;
      }
    });
    if (meta['og:image']) {
      return meta['og:image'];
    } else if (meta['og:image:secure_url']) {
      return meta['og:image:secure_url'];
    } else if (meta['og:image:url']) {
      return meta['og:image:url'];
    }
    else if (meta['twitter:image']) {
      return meta['twitter:image'];
    }
  }
  catch (ex) {
    ng.logger.warn(ng.colour.red+'Fetch social',ex.message+ng.colour.normal);
  }
  try {
    const icon = await fetchFavicon(url);
    if (typeof icon === 'string' && !icon.endsWith('/favicon.ico')) {
      ng.logger.log('📷',icon);
      candidate.parent.patch = ng.Tree(candidate.parent.patch); // doesn't create Trees recursively from init
      candidate.parent.patch.info = ng.Tree(candidate.parent.patch.info);
      candidate.parent.patch.info['x-logo'].url = icon;
      return icon;
    }
  }
  catch (ex) {
    ng.logger.warn(ng.colour.red+'Fetch favicon',ex.message+ng.colour.normal);
  }
}

async function optionallyAutoUpgrade(o, candidate) {
  const version = majorMinor(o.openapi || o.swagger);
  if ((version !== majorMinor(oasDefaultVersion)) || (candidate.md.autoUpgrade && candidate.md.autoUpgrade !== oasDefaultVersion)) {
    ng.logger.prepend('U');
    if (candidate.md.autoUpgrade) valOpt.targetVersion = candidate.md.autoUpgrade;
    await s2o.convertObj(o, valOpt);
    return valOpt.openapi;
  }
  else {
    // TODO other formats
  }
  return o;
}

async function validateObj(o,s,candidate,source) {
  valOpt.text = s;
  valOpt.targetVersion = oasDefaultVersion;
  let result = { valid: false };
  if (!o) o = {};
  try {
    if (o.id && o.requests) {
      const options = { inputVersion: '1.0.0', outputVersion: '2.1.0', retainIds: true };
      o = await postman1(o, options);
      s = JSON.stringify(o);
    }
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
      s = s.split('{{url}}').join(argv.host);
      o = postman.transpile(o,'json');
      valOpt.openapi = o;
      valOpt.patches = 1; // force taking from valOpt.openapi
    }
    else { // $ref doesn't mean a JSON Reference in google discovery land
      if (!argv.stub && resOpt.resolve && (candidate.md.resolve !== false)) {
        ng.logger.prepend('R');
        await resolver.resolve(o,source,resOpt);
        o = resOpt.openapi;
      }
    }
    if (o.openapi && o.openapi.startsWith('3.0') && o.webhooks) { // seen in adyen, issue #23
      candidate.md.autoUpgrade = '3.1.0';
      if (!o.servers && argv.provider) {
        o.servers = [ { url: `https://${argv.providerKey}` } ];
      }
    }
    o = await optionallyAutoUpgrade(o, candidate);
    if (o.info) {
      if (typeof o.info.version !== 'string') {
        o.info.version = (o.info.version || defaultVersion).toString();
      }
      if (o.info.version.endsWith('.')) o.info.version = o.info.version.substring(0, o.info.version.length -1); // windows can't check these out #974, see ng.cleanseversion should we be doing it there?
    }
    if (o.openapi) { // checking openapi property
      ng.logger.prepend('V');
      await validator.validate(o, valOpt);
      result = valOpt;
    }
    else if (o.asyncapi) {
      ng.logger.prepend('*');
      result.valid = true; // TODO validate asyncapi
    }
    if (!result.valid) throw new Error(`Validation failure, OpenAPI ${o.openapi||o.swagger||o.swaggerVersion}`);
  }
  catch (ex) {
    ng.logger.log();
    ng.logger.warn(ng.colour.red+(ex.message||'No exception message')+ng.colour.normal);
    if (argv.debug) ng.logger.warn(ex);
    let context;
    if (valOpt.context) {
      context = valOpt.context.pop();
      ng.logger.warn(ng.colour.red+context+ng.colour.normal);
    }
    ng.fail(candidate,null,ex,context);
  }
  ng.logger.log('',result.valid ? ng.colour.green+'✔' : ng.colour.red+'✗',ng.colour.normal);
  const oValid = candidate.md.valid;
  candidate.md.valid = result.valid;
  if (oValid && !result.valid) {
    slack(`API Registry: ${candidate.provider} ${candidate.service} ${candidate.version} just flipped from valid to invalid`);
  }
  return result.valid;
}

async function fix(candidate, o) {
  // TODO use jmespath queries to fix up stuff
}

async function retrieve(u, argv, slow) {
  let response = { status: 599, ok: false, headers: {} };
  let s;
  let ok;

  if (argv.cached) {
    u = url.pathToFileURL(argv.cached).toString();
  }

  if (argv.provider && argv.provider.data && argv.provider.data.length) {
    ng.logger.prepend('S');
    const dataItem = argv.provider.data.find(function(e,i,a){
      return (e.url === u);
    });
    if (dataItem) {
      return { response: { ok: true, status: 200 }, text: dataItem.text };
    }
    else {
      ng.logger.warn(ng.colour.red,`Could not find ${u} in stored data`,ng.colour.normal);
      argv.provider.data.find(function(e,i,a){
        ng.logger.warn('Found',e.url);
      })
      return { response: { ok: false, status: 404 } };
    }
  }

  if (u.startsWith('http') || u.startsWith('blob')) {
    ng.logger.prepend('F');
    const timeout = slow ? 15000 : 5000;
    const headers = { 'Accept': '*/*', 'Accept-Encoding': 'gzip,deflate' };
    if (argv.body) headers['Content-Type'] = 'application/json';
    response = await fetch(u, { logToConsole: argv.verbose, timeout, signal: AbortSignal.timeout(timeout), agent:bobwAgent, cacheFolder: mainCache, refresh: 'default', method: (argv.method||'GET'), body: argv.body, headers });
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
    response.url = url.pathToFileURL(u).toString();
  }
  return { response, text:s }
}

async function getObjFromText(text, candidate, ct) {
  if (text.startsWith('FORMAT: ')) {
    if (!apiBlueprint) {
       apib2swagger = require('apib2swagger');
       apiBlueprint = util.promisify(apib2swagger.convert);
    }
    const result = await apiBlueprint(text,{});
    candidate.md.autoUpgrade = oasDefaultVersion;
    return result.swagger;
  }
  else {
    let obj;
    try {
      obj = ng.yamlParse(text);
    }
    catch (ex) {
      ng.logger.warn('Falling back to lenient yaml...');
      try {
        obj = yml.parse(text, { strict: false, loglevel: 'silent', prettyErrors: true });
      }
      catch (ex) {
        ng.logger.warn('Failed to parse input as yaml or API Blueprint.');
        if (ct) ng.logger.warn(`Content-Type: ${ct}`);
        process.exitCode = 1;
      }
    }
    return obj;
  }
}

function updatePreferredFlag(candidate, flag) {
  try {
    const s = fs.readFileSync(candidate.md.filename,'utf8');
    const api = ng.yamlParse(s);
    api.info["x-preferred"] = flag;
    fs.writeFileSync(candidate.md.filename,ng.yamlStringify(api),'utf8');
    candidate.md.preferred = flag;
  }
  catch (ex) {
    ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
    if (argv.debug) ng.logger.warn(ex);
  }
  return candidate;
}

function countEndpoints(o) {
  return Object.keys(o.paths||o.webhooks||o.topics||o.channels||{}).length;
}

function runGC(snapshot) {
  iteration++;
  if (iteration % 100 === 0) {
    ng.logger.prepend('🗑️');
    if (global.gc) global.gc();
    if (snapshot) saveHeapSnapshot();
  }
}

const commands = {
  checkpref: async function(candidate) {
    ng.logger.log('nop');
    return true;
  },
  list: async function(candidate) {
    ng.logger.log('nop');
    return true;
  },
  sort: async function(candidate) {
    ng.logger.log('nop');
    return true;
  },
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
  metadata: async function(candidate) {
    ng.logger.log();
    ng.logger.log(ng.yamlStringify(candidate.md));
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
    let o = ng.yamlParse(s);
    if (o.info) {
      o.info['x-preferred'] = candidate.md.preferred;
    }
    o = await optionallyAutoUpgrade(o, candidate);
    // FIXME doesn't update candidate.md.filename or perform mv
    fs.writeFileSync(candidate.md.filename,ng.yamlStringify(o),'utf8');
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
      const o = ng.yamlParse(s);
      candidate.md.endpoints = countEndpoints(o);
      if (candidate.md.endpoints === 0) {
        fs.unlinkSync(candidate.md.filename);
        delete candidate.parent[candidate.version];
      }
      ng.logger.log(ng.colour.green+'e:'+candidate.md.endpoints,ng.colour.normal);
    }
    catch (ex) {
      ng.fail(candidate,null,ex,'endpoints');
      ng.logger.log(ng.colour.red+ex.message,ng.colour.normal);
    }
  },
  cache: async function(candidate) {
    let s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = ng.yamlParse(s);
    const origin = o.info['x-origin'];
    const source = ng.clone(origin[origin.length-1]);

    source.url = source.url.replace('https://raw.githubusercontent.com/NYTimes/public_api_specs/master','./metadata/nytimes.com.cache/public_api_specs-master');
    source.url = source.url.replace('https://raw.githubusercontent.com/Azure/azure-rest-api-specs/master','./metadata/azure.com.cache/azure-rest-api-specs-master');
    source.url = source.url.replace('file://localhost/','');

    origin.push(source);
    fs.writeFileSync(candidate.md.filename,ng.yamlStringify(o),'utf8');
    candidate.md.history = ng.clone(origin);
    candidate.md.source = candidate.md.history.pop();
    ng.logger.log('cache');
  },
  logo: async function(candidate) {
    const logo = await getSocial(candidate);
    ng.logger.log(logo);
    const patch = Object.assign({},candidate.parent.patch,candidate.gp.patch);
    if (argv.force || !patch || !patch.info || !patch.info['x-logo']) {
      candidate.gp.patch = new ng.Tree(candidate.gp.patch || {});
      candidate.gp.patch.info['x-logo'].url = logo;
    }
    return candidate;
  },
  deploy: async function(candidate) {
    if (argv.dashboard) {
      ng.logger.log();
      candidate.info = { title: 'API', version: candidate.version, 'x-origin': [ { url: candidate.md.source } ] };
      return candidate;
    }

    runGC(false);

    let s;
    let o;
    try {
      s = fs.readFileSync(candidate.md.filename,'utf8');
      o = ng.yamlParse(s);
    }
    catch (ex) {
      if (candidate.md.filename.indexOf('azure.com') < 0) {
        ng.fail(candidate,null,ex,'deploy');
      }
      ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
    }
    const defaultLogo = 'https://apis.guru/assets/images/no-logo.svg'; // this is ok for generic registries too
    let origLogo = defaultLogo;
    if ((o && o.info['x-logo']) && (o.info['x-logo'].url)) {
      origLogo = o.info['x-logo'].url;
    }
    let logoName = origLogo.split('://').join('_').split('/').join('_').split('?')[0];
    let logoFull = path.join(logoPath,logoName);
    while (logoFull.length >= 250) {
      logoName = logoName.substr(0,logoName.length-1);
      logoFull = logoFull.substr(0,logoFull.length-1);
    }
    const logoExt = candidate.md.logoExt||candidate.parent.logoExt||candidate.gp.logoExt;
    if (typeof logoExt === 'string') { // may be being set to {} by a Tree
      logoName += logoExt;
      logoFull += logoExt;
    }

    let colour = ng.colour.green;
    if (!fs.existsSync(logoFull)) { // if we have not deployed this logo yet
      let response;
      try {
        const res = await cfetch(origLogo, {timeout:3500, agent:bobwAgent, cacheFolder: logoCache, refresh: 'never'});
        response = await res.buffer();
        const ct = res.headers.get('Content-Type')||'';
        if (!res.ok || ct.indexOf('image/')<0) {
          throw new Error(`Content-Type: ${ct}`);
        }
        const lnl = logoName.toLowerCase();
        if (ct.indexOf('image/png')>=0) {
          if (lnl.indexOf('.png')<0) {
            logoName += '.png';
            logoFull += '.png';
          }
        }
        if (ct.indexOf('image/svg+xml')>=0) {
          if (lnl.indexOf('.svg')<0) {
            logoName += '.svg';
            logoFull += '.svg';
          }
        }
        if (ct.indexOf('image/jpeg')>=0) {
          if (lnl.indexOf('.jpeg')<0 && lnl.indexOf('.jpg')<0) {
            logoName += '.jpeg';
            logoFull += '.jpeg';
          }
        }
      }
      catch (ex) {
        colour = ng.colour.yellow;
        ng.logger.warn(colour+ex.message+ng.colour.normal);
        if (argv.debug) ng.logger.warn(ex);
        const res = await cfetch(defaultLogo, {timeout:3500, agent:bobwAgent, cacheFolder: logoCache, refresh: 'never'});
        response = await res.buffer();
      }
      if (response) {
        try {
          fs.writeFileSync(logoFull,response);
        }
        catch (ex) {
          ng.fail(candidate,null,ex,'deploy');
          ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
        }
      }
    }
    ng.logger.prepend(colour+'📷 '+ng.colour.normal);

    if (o) {
      if (!o.info['x-logo']) o.info['x-logo'] = {};
      o.info['x-logo'].url = 'https://api.apis.guru/v2/cache/logo/'+logoName; // FIXME hardcoded
      candidate.info = o.info; // update the logo for list.json too
      candidate.externalDocs = o.externalDocs;
      candidate.logoUrl = o.info['x-logo'].url;

      s = ng.yamlStringify(o);
      const j = JSON.stringify(o,null,2);
      const filename = candidate.md.filename.split('/').pop().replace('.yaml','');
      let filepath = path.resolve('.','deploy','v2','specs');
      filepath = path.join(filepath,candidate.provider,candidate.service,candidate.version);
      await mkdirp(filepath);
      fs.writeFileSync(path.join(filepath,filename+'.yaml'),s,'utf8');
      fs.writeFileSync(path.join(filepath,filename+'.json'),j,'utf8');
      ng.logger.log(ng.colour.green+'✔'+ng.colour.normal);
      return true;
    }
    return false;
  },
  docs: async function(candidate) {
    let docpath = path.resolve('.','deploy','docs',candidate.provider,candidate.service);
    await mkdirp(docpath);
    docpath += '/'+candidate.version+'.html';
    let landingText = '';
    if (landingPages.has(candidate.provider)) {
      landingText = landingPages.get(candidate.provider);
    }
    else {
      const landingFile = path.resolve('.','metadata','landingPages',candidate.provider+'.txt');
      if (fs.existsSync(landingFile)) {
        landingText = fs.readFileSync(landingFile,'utf8');
      }
      else {
        landingText = '';
      }
      landingPages.set(candidate.provider, landingText);
    }
    const html = await htmlTemplate.render({ url: getApiUrl(candidate,'.json'), provider: candidate.provider,
      title: `${candidate.provider} - ${candidate.service} - ${candidate.version}`, landingText } );
    fs.writeFileSync(docpath,html,'utf8');
    apiList += await listTemplate.render({ url: path.relative('./deploy/docs',docpath), title: `${candidate.provider} - ${candidate.service} - ${candidate.version}`});
    ng.logger.log(ng.colour.green+'📚'+ng.colour.normal);
  },
  validate: async function(candidate) {
    try {
      const s = fs.readFileSync(candidate.md.filename,'utf8');
      const o = ng.yamlParse(s);
      const valid = await validateObj(o,s,candidate,candidate.md.filename); // can call ng.fail()
      if (!valid) process.exitCode = 1;
      return valid;
    }
    catch (ex) {
      ng.fail(candidate,null,ex,'validate');
      ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
    }
  },
  ci: async function(candidate) {
    const diff = Math.round(Math.abs((new Date(ng.now) - new Date(candidate.md.updated)) / dayMs));
    if (diff <= 1.1) {
      try {
        runGC(false);
        const s = fs.readFileSync(candidate.md.filename,'utf8');
        const o = ng.yamlParse(s);
        const valid = await validateObj(o,s,candidate,candidate.md.filename); // can call ng.fail()
        if (!valid) process.exitCode = 1;
        return valid;
      }
      catch (ex) {
        ng.fail(candidate,null,ex,'validate');
        ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
      }
    }
    else {
      ng.logger.log(ng.colour.yellow+'🕓'+ng.colour.normal);
    }
  },
  check: async function(u, metadata) {
    ng.logger.prepend(u+' ');
    try {
      const result = await retrieve(u,argv);
      if (result.response.ok) {
        const ct = result.response.headers.get('Content-Type');
        const candidate = { md: { source: { url: u }, valid: false } };
        let o = await getObjFromText(result.text, candidate, ct);
        const valid = await validateObj(o,result.text,candidate,candidate.md.source.url);
        if (valOpt.openapi) o = valOpt.openapi;

        candidate.md.endpoints = countEndpoints(o);
        if (candidate.md.endpoints === 0) {
          ng.logger.warn('Cannot add API with 0 endpoints');
          process.exitCode = 1;
        }
        let ou = getServer(o, u);
        ng.logger.log(getProvider(ou, u));
      }
      else {
        ng.logger.warn(ng.colour.red,result.response.status,ng.colour.normal);
        process.exitCode = 1;
      }
    }
    catch (ex) {
      ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
      if (argv.debug) ng.logger.warn(ex);
      process.exitCode = 1;
    }
  },
  add: async function(u, metadata) {
    ng.logger.prepend(u+' ');
    try {
      const result = await retrieve(u, argv, true);
      if (result.response.ok) {
        if (result.response.url) {
          u = result.response.url;
        }
        const candidate = { md: { source: { url: u }, valid: false, autoUpgrade: argv.autoUpgrade } };
        let o = await getObjFromText(result.text, candidate);
        const org = o;
        const valid = await validateObj(o,result.text,candidate,candidate.md.source.url);
        if (valid || argv.force) {
          if ((valOpt.patches > 0) || (valOpt.convWarn.length) || candidate.md.autoUpgrade) {
            o = valOpt.openapi;
          }
          let ou = getServer(o, u);

          const provider = getProvider(ou, u);
          candidate.provider = provider;
          assert.ok(provider,'Provider not defined');
          const service = argv.service || '';
          candidate.service = service;
          if (!metadata[provider]) {
            metadata[provider] = { driver: 'url', apis: {} };
          }
          else {
            for (let service in metadata[provider].apis) {
              let apis = metadata[provider].apis[service];
              for (let version in apis) {
                const api = apis[version];
                if (api.source) assert.ok(api.source.url !== u,'URL already in metadata');
              }
            }
          }
          if (!metadata[provider].apis[service]) {
            metadata[provider].apis[service] = {};
          }
          candidate.parent = metadata[provider].apis[service];
          candidate.gp = metadata[provider];

          if (argv.logo) {
            if (!o.info['x-logo']) {
              o.info['x-logo'] = {};
            }
            o.info['x-logo'].url = argv.logo;
          }

          let gotLogo = false;
          if ((o.info['x-logo']) && (o.info['x-logo'].url)) {
            let colour = ng.colour.yellow;
            try {
              // check the logo URL and populate the logoCache
              const res = await fetch(o.info['x-logo'].url, {timeout:3500, agent:bobwAgent, cacheFolder: logoCache, refresh: 'once'});
              if (res.ok && res.headers.get('Content-Type').indexOf('image/')>=0) {
                candidate.md.logoMediaType = res.headers.get('Content-Type');
                gotLogo = true;
                colour = ng.colour.green;
              }
            }
            catch (ex) {}
            ng.logger.prepend(colour+'📷 '+ng.colour.normal);
          }
          if (candidate.gp.patch && candidate.gp.patch.info && candidate.gp.patch.info['x-logo']) gotLogo = true;
          if (candidate.parent.patch && candidate.parent.patch.info && candidate.parent.patch.info['x-logo']) gotLogo = true;
          if (!gotLogo && provider.indexOf('.local') < 0) {
            const logo = await getSocial(candidate);
            if (logo) {
              gotLogo = true;
              if (!o.info['x-logo']) o.info['x-logo'] = { url: logo };
            }
          }

          if (argv.desclang) {
            o.info['x-description-language'] = argv.desclang;
          }

          candidate.md.added = ng.now;
          candidate.md.updated = ng.now;
          candidate.md.history = [];
          candidate.md.fixes = valOpt.patches;
          if (valOpt.convWarn && valOpt.convWarn.length) {
            candidate.md.fixes += valOpt.convWarn.length;
          }
          if (org.openapi) {
            candidate.md.name = 'openapi.yaml';
            candidate.md.source.format = 'openapi';
            candidate.md.source.version = majorMinor(org.openapi);
            candidate.md.openapi = o.openapi;
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
            candidate.md.source.version = majorMinor(org.asyncapi);
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
          else if (org.id && org.requests) {
            candidate.md.name = 'openapi.yaml';
            candidate.md.source.format = 'postman';
            candidate.md.source.version = '1.0';
            candidate.md.openapi = o.openapi;
          }
          if (o.info && (o.info.version === '' || o.info.version === 'version')) {
            o.info.version = defaultVersion;
          }

          candidate.md.endpoints = countEndpoints(o);
          if (candidate.md.endpoints === 0) {
            ng.logger.warn('Not writing API with 0 endpoints');
            process.exitCode = 1;
            return false;
          }

          // this is where we commit to updating the metadata and writing the API definition
          candidate.version = ng.cleanseVersion(o.info.version);
          metadata[provider].apis[service][candidate.version] = candidate.md;

          const filepath = path.resolve('.','APIs',provider,service,candidate.version);
          await mkdirp(filepath);
          const filename = path.resolve(filepath,candidate.md.name);
          candidate.md.filename = path.relative('.',filename);
          if (argv.cached) candidate.md.cached = argv.cached;

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

          const patch = ng.Tree(candidate.parent.patch);

          if (argv.categories) {
            const categories = argv.categories.split(',');
            o.info['x-apisguru-categories'] = categories;
            patch.info['x-apisguru-categories'] = categories;
          }
          if (o.info['x-logo']) {
            patch.info['x-logo'] = o.info['x-logo'];
          }
          if (argv.desclang) {
            patch.info['x-description-language'] = o.info['x-description-language'];
          }

          if (Object.keys(patch).length) {
            candidate.parent.patch = patch;
          }
          o = deepmerge(o,candidate.gp.patch||{});

          const content = ng.yamlStringify(ng.sortJson(o));
          candidate.md.hash = ng.sha256(content);
          fs.writeFileSync(filename,content,'utf8');
          newCandidates.push(candidate);
          ng.logger.log('Wrote new',provider,service||'-',candidate.version,'in OpenAPI',candidate.md.autoUpgrade||candidate.md.openapi,'fixes',candidate.md.fixes||0,valid ? ng.colour.green+'✔' : ng.colour.red+'✗',ng.colour.normal);
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

    runGC(true);

    try {
      const result = await retrieve(u, { cached: candidate.md.cached, provider: candidate.gp, method: candidate.gp.method, body: candidate.md.body });

      let o = {};
      let autoUpgrade;
      if (result && result.response.ok) {
        delete candidate.md.statusCode;
        const s = result.text;
        o = await getObjFromText(s, candidate);
        const valid = await validateObj(o,s,candidate,candidate.md.source.url);
        if (valid) {
          // TODO if there is a logo.url try and fetch/cache it (if changed?)

          if ((valOpt.patches > 0) || (valOpt.convWarn.length) || (candidate.md.autoUpgrade)) {
            // passed validation as OAS 3 but only by patching the source
            // therefore the original OAS 2 document might not be valid as-is
            o = valOpt.openapi;
            autoUpgrade = o.openapi;
          }

          if (o.info && (o.info.version === '')) {
            o.info.version = defaultVersion;
          }

          let openapiVer = (o.openapi ? o.openapi : o.swagger);
          const newVersion = o.info ? ng.cleanseVersion(o.info.version) : defaultVersion;
          if ((o.info && (newVersion !== candidate.version)) || (openapiVer !== candidate.md.openapi)) {
            ng.logger.log('  Updated to',newVersion,'in OpenAPI',openapiVer);
            if (newVersion !== candidate.version) {
              candidate.parent[newVersion] = candidate.parent[candidate.version];
              delete candidate.parent[candidate.version];
              // candidate.version remains the old version
            }
            const ofname = candidate.md.filename;
            candidate.md.filename = candidate.md.filename.replace('/'+candidate.version+'/','/'+newVersion+'/');
            if (o.openapi) {
              candidate.md.filename = candidate.md.filename.replace('swagger.yaml','openapi.yaml');
              candidate.md.name = 'openapi.yaml';
              candidate.md.source.format = 'openapi';
              candidate.md.source.version = majorMinor(o.openapi);
            }
            const pathname = path.dirname(candidate.md.filename);
            mkdirp.sync(pathname);
            if (ofname !== candidate.md.filename) {
              ng.exec("mv '"+ofname+"' '"+candidate.md.filename+"'"); // TODO use shelljs ?
            }
          }

          // TODO set converter in origin if necessary

          // FIXME clean patches of erroneous source.url properties created
          // by treating a patch 'version' in the metadata as if it were an API
          o = deepmerge(o,candidate.gp.patch||{});
          o = deepmerge(o,candidate.parent.patch||{});

          if (o.info['x-apisguru-categories']) {
            // deduplicate categories array
            o.info['x-apisguru-categories'] = Array.from(new Set(o.info['x-apisguru-categories']));
          }
          o.info['x-providerName'] = candidate.provider;
          const origin = ng.clone(candidate.md.history);
          origin.push(candidate.md.source);
          o.info['x-origin'] = origin;
          if (candidate.service) o.info['x-serviceName'] = candidate.service;
          if (typeof candidate.md.preferred === 'boolean') o.info['x-preferred'] = candidate.md.preferred;
          if (candidate.md.unofficial) o.info['x-unofficialSpec'] = true;
          if (candidate.provider.indexOf('.local')>0) {
            if (!o.swagger) {
              if (!o.servers) o.servers = [];
              const existing = o.servers.find(function(e,i,a){
                return e.url.indexOf(candidate.provider)>=0;
              });
              if (!existing) o.servers.unshift({ url: 'http://'+candidate.provider });
            }
          }

          const content = ng.yamlStringify(ng.sortJson(o));
          fs.writeFileSync(candidate.md.filename,content,'utf8');
          const newHash = ng.sha256(content);
          if (candidate.md.hash !== newHash) {
            candidate.md.hash = newHash;
            candidate.md.updated = ng.now;
          }
          candidate.md.endpoints = countEndpoints(o);
          candidate.md.fixes = valOpt.patches;
          if (valOpt.convWarn && valOpt.convWarn.length) {
            candidate.md.fixes += valOpt.convWarn.length;
          }
          if (autoUpgrade) {
            candidate.md.autoUpgrade = autoUpgrade;
            if (o.openapi || o.swagger) candidate.md.openapi = autoUpgrade;
          }
        }
        else { // if not valid
          if (argv.save) {
            fs.writeFileSync('./temp.yaml',ng.yamlStringify(o),'utf8');
          }
          return false;
        }
      }
      else { // if not status 200 OK
        if (result.response.status !== candidate.md.statusCode) {
          candidate.md.statusCode = result.response.status;
          slack(`API Registry: ${candidate.provider} ${candidate.service} ${candidate.version} just flipped to status ${result.response.status}`);
        }
        if (candidate.md.preferred === true) {
          // can't be preferred if no longer available
          // need to write this back even though update failed
          updatePreferredFlag(candidate, false);
        }
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
  },
  remove: async function(candidate, metadata) {
    const filename = candidate.md.filename;
    ng.logger.log(ng.colour.red+'␡'+ng.colour.normal);
    try {
      ng.exec(`rm ${candidate.md.filename}`); // TODO use shelljs ?
    }
    catch (ex) {}
    delete metadata[candidate.provider].apis[candidate.service][candidate.version];
    if (Object.keys(metadata[candidate.provider].apis[candidate.service]).length === 0) {
      delete metadata[candidate.provider].apis[candidate.service];
    }
    if (Object.keys(metadata[candidate.provider].apis).length === 0) {
      delete metadata[candidate.provider];
    }
  }
};

function rssFeed(data,updated) {
  let feed = {};
  let rss = {};

  let d = new Date(ng.now);

  ng.logger.log('RSS Feed...',updated,Object.keys(data).length);

  rss['@version'] = '2.0';
  rss["@xmlns:atom"] = 'http://www.w3.org/2005/Atom';
  rss.channel = {};
  rss.channel.title = 'APIs.guru OpenAPI directory RSS feed'; // FIXME hardcoded
  rss.channel.link = 'https://api.apis.guru/v2/list.rss';
  rss.channel["atom:link"] = {};
  rss.channel["atom:link"]["@rel"] = 'self';
  rss.channel["atom:link"]["@href"] = rss.channel.link;
  rss.channel["atom:link"]["@type"] = 'application/rss+xml';
  rss.channel.description = rss.channel.title;
  rss.channel.webMaster = 'mike.ralphson@gmail.com (Mike Ralphson)';
  rss.channel.pubDate = d.toUTCString();
  rss.channel.generator = 'openapi-directory https://github.com/apis-guru/openapi-directory';
  rss.channel.item = [];

  for (let api in data) {
      let p = data[api].versions[data[api].preferred];
      if (p && p.info) {
        let i = {};
        i.title = `${api} ${data[api].preferred} ${p.info.title}`;
        i.link = p.info["x-origin"][0].url;
        i.description = removeMarkdown(p.info.description ? p.info.description.trim().split('\n')[0] : p.info.title);
        i.category = 'APIs';
        i.guid = {};
        i.guid["@isPermaLink"] = 'false';
        i.guid[""] = api;
        i.pubDate = new Date((updated ? p.updated : p.added)).toUTCString();

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
  let result = 'https://api.apis.guru/v2/specs/'+candidate.provider; // FIXME hardcoded
  if (candidate.service) result += '/' + candidate.service;
  result += '/' + candidate.version + '/' + ((candidate.md.name||'').replace('.yaml','')) + ext;
  return result;
}

function badges(metrics) {
  const badgepath = path.resolve('.','deploy','badges');
  ng.logger.log('Badges...');
  mkdirp.sync(badgepath);
  const badges = [
    { label: 'APIs in directory', name: 'apis_in_collection.svg', prop: 'numAPIs', color: 'orange' },
    { label: 'Endpoints', name: 'endpoints.svg', prop: 'numEndpoints', color: 'cyan' },
    { label: 'OpenAPI Docs', name: 'openapi_specs.svg', prop: 'numSpecs', color: 'yellow' },
    { label: '🐝 Tested on', name: 'tested_on.svg', prop: 'numSpecs', color: 'green' },
    { label: '✗ Invalid at source', name: 'invalid.svg', prop: 'invalid', color: (metrics.invalid === 0 ? 'green' : 'red') },
    { label: '🖧  Unreachable', name: 'unreachable.svg', prop: 'unreachable', color: (metrics.unreachable === 0 ? 'green' : 'red') },
    { label: '🐒 Fixes', name: 'fixes.svg', prop: 'fixes', color: 'lime' },
    { label: '🔧 Fixed %', name: 'fixed_pct.svg', prop: 'fixedPct', color: 'orange' },
    { label: '🏎️  Drivers', name: 'drivers.svg', prop: 'numDrivers', color: 'cyan' },
    { label: '🏢 Providers', name: 'providers.svg', prop: 'numProviders', color: 'magenta' }
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
    return candidates;
  },
  docs: async function(candidates) {
    htmlTemplate = await liquidEngine.parse(fs.readFileSync(path.resolve(__dirname,'templates','landing.html'),'utf8'));
    listTemplate = await liquidEngine.parse(fs.readFileSync(path.resolve(__dirname,'templates','partial.html'),'utf8'));
    return candidates;
  },
  ci: async function(candidates) {
    resOpt.resolve = false; // should already have been done
    valOpt.repair = false; // should already have been done
    return candidates;
  },
  validate: async function(candidates) {
    resOpt.resolve = false; // should already have been done
    valOpt.repair = false; // should already have been done
    return candidates.filter(function(e,i,a) {
      return (e.provider !== 'azure.com'); // temp FIXME azure services
    });
  }
};

const wrapUp = {
  deploy: async function(candidates) {

    let totalEndpoints = 0;
    let unreachable = 0;
    let invalid = 0;
    let unofficial = 0;
    let fixed = 0;
    let fixes = 0;
    let compare = 0;
    let added = 0;
    let updated = 0;

    const datasets = [];
    const providerCount = {};
    const list = {};
    let listCsv = 'API,Provider,Service,Version,Description,LogoUrl\n';

    ng.logger.log('API list...');

    for (let candidate of candidates) {
      if (typeof candidate.md.endpoints === 'number') {
        totalEndpoints += candidate.md.endpoints;
      }
      if (typeof candidate.md.fixes === 'number') {
        if (candidate.md.fixes > 1) {
          fixed++; // 1 is a special case for now, where we've forced a conversion
          fixes += candidate.md.fixes;
        }
        compare++;
      }
      if (candidate.md.valid === false) invalid++;
      if (candidate.md.unofficial) unofficial++;
      if (new Date(candidate.md.added) >= ng.weekAgo) added++;
      if (new Date(candidate.md.updated) >= ng.weekAgo) updated++;
      if (candidate.md.statusCode) {
        const range = candidate.md.statusCode.toString().substr(0,1);
        if ((range === '4') || (range === '5')) {
          unreachable++;
        }
      }

      let key = candidate.provider;
      if (!providerCount[key]) providerCount[key] = 0;
      providerCount[key]++;
      if (candidate.service) key += ':'+candidate.service;

      const cVersion = ng.cleanseVersion(candidate.version);

      if (!list[key]) {
        list[key] = { added: candidate.md.added, preferred: cVersion, versions: {} };
      }
      list[key].versions[cVersion] = { added: candidate.md.added, info: candidate.info, externalDocs: candidate.externalDocs, updated: candidate.md.updated||candidate.md.added, swaggerUrl: getApiUrl(candidate, '.json'), swaggerYamlUrl: getApiUrl(candidate,'.yaml'), openapiVer: candidate.md.openapi };
      if (candidate.md.preferred) list[key].preferred = cVersion;
      listCsv += candidate.info.title.split(',')[0] + ',' + candidate.provider + ',' + candidate.service + ',' + candidate.version + ',' + (candidate.info.description||'').split('\n')[0].split(',')[0] + ',' + candidate.logoUrl + '\n';
    }

    const numProviders = Object.keys(providerCount).length;
    let others = 0;
    for (let provider in providerCount) {
      if (providerCount[provider] < 10) {
        others += providerCount[provider];
        delete providerCount[provider];
      }
    }
    providerCount.Others = others;
    datasets.push({ title: 'providerCount', data: providerCount });

    const ghRes = await fetch('https://api.github.com/repos/APIs-guru/openapi-directory', { cacheFolder: mainCache, refresh: 'force' }); // FIXME hardcoded
    const ghStats = await ghRes.json();

    const metrics = {
      numSpecs: candidates.length,
      numAPIs: Object.keys(list).length,
      numEndpoints: totalEndpoints,
      unreachable,
      invalid,
      unofficial,
      fixes,
      fixedPct: Math.round((fixed/compare)*100.0),
      datasets,
      stars: ghStats.stargazers_count,
      issues: ghStats.open_issues_count,
      thisWeek: { added, updated },
      numDrivers: ng.numDrivers,
      numProviders
    };
    badges(metrics);

    fs.writeFileSync(path.resolve('.','deploy','v2','list.json'),JSON.stringify(list,null,2),'utf8');
    fs.writeFileSync(path.resolve('.','deploy','v2','list.csv'),listCsv,'utf8');
    fs.writeFileSync(path.resolve('.','deploy','v2','metrics.json'),JSON.stringify(metrics,null,2),'utf8');
    fs.writeFileSync(path.resolve('.','deploy','v2','list.rss'),rssFeed(list,true),'utf8');
    fs.writeFileSync(path.resolve('.','deploy','v2','added.rss'),rssFeed(list,false),'utf8');
    fs.writeFileSync(path.resolve('.','deploy','.nojekyll'),'','utf8');
    try {
      const cname = fs.readFileSync(path.resolve('.','metadata','CNAME'),'utf8');
      fs.writeFileSync(path.resolve('.','deploy','CNAME'),cname,'utf8');
      const indexHtml = fs.readFileSync(path.resolve('.','metadata','index.html'),'utf8');
      fs.writeFileSync(path.resolve('.','deploy','index.html'),indexHtml,'utf8');
      const chartHtml = fs.readFileSync(path.resolve('.','metadata','charts.html'),'utf8');
      fs.writeFileSync(path.resolve('.','deploy','charts.html'),chartHtml,'utf8');
      const ourAPI = fs.readFileSync(path.resolve('.','metadata','openapi.yaml'),'utf8');
      fs.writeFileSync(path.resolve('.','deploy','v2','openapi.yaml'),ourAPI,'utf8');
      const categories = fs.readFileSync(path.resolve('.','metadata','categories.yaml'),'utf8');
      fs.writeFileSync(path.resolve('.','deploy','v2','categories.yaml'),categories,'utf8');
      const logo = fs.readFileSync(path.resolve('.','metadata','logo.svg'),'utf8');
      fs.writeFileSync(path.resolve('.','deploy','logo.svg'),logo,'utf8');
    }
    catch (ex) {
      ng.logger.warn(ng.colour.red+ex.message+ng.colour.normal);
    }
  },
  docs: async function(candidates) {
    const indexTemplate = await liquidEngine.parse(fs.readFileSync(path.resolve(__dirname,'templates','index.html'),'utf8'));
    const index = await indexTemplate.render({ apiList });
    fs.writeFileSync(path.resolve('.','deploy','docs','index.html'),index,'utf8');
    const sitemapTemplate = await liquidEngine.parse(fs.readFileSync(path.resolve(__dirname,'templates','sitemap.xml'),'utf8'));
    const sitemap = await sitemapTemplate.render({ date: ng.now, baseUrl: 'https://api.apis.guru' }); // FIXME hardcoded
    fs.writeFileSync(path.resolve('.','deploy','sitemap.xml'),sitemap,'utf8');
    fs.writeFileSync(path.resolve('.','deploy','robots.txt'),fs.readFileSync(path.resolve('.','metadata','robots.txt'),'utf8'),'utf8');
  },
  update: async function(candidates) {
    const services = ng.Tree({});
    for (let candidate of candidates) {
      let key = candidate.provider;
      if (candidate.service) key += ':'+candidate.service;
      services[key].versions[candidate.version] = candidate;
    }
    for (let key in services) {
      const versions = services[key].versions;
      let numPreferred = 0;
      let preferredVersion = '';
      let maxAdded = new Date(0); // 1970
      for (let version in versions) {
        let candidate = versions[version];
        if (candidate.md.preferred) {
          numPreferred++;
        }
        const d = new Date(candidate.md.added);
        if (d >= maxAdded) {
          maxAdded = d;
          preferredVersion = version;
        }
      }
      if (Object.keys(versions).length === 1) {
        let candidate = versions[preferredVersion];
        updatePreferredFlag(candidate, undefined);
      }
      if ((Object.keys(versions).length > 1)) { // && (numPreferred !== 1)) {
        ng.logger.log(key,numPreferred,preferredVersion,maxAdded);
        for (let version in versions) {
          let candidate = versions[version];
          const newPreferred = (version === preferredVersion);
          if (candidate.md.preferred !== newPreferred) {
            updatePreferredFlag(candidate, newPreferred);
          }
        }
      }
    }
  }
};
wrapUp.checkpref = wrapUp.update;
wrapUp.list = wrapUp.deploy;

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

async function main(command, pathspec = ng.defaultPathSpec, options) {
  process.exitCode = 99;
  argv = options; // set the global variable
  const metadata = ng.loadMetadata(command);

  if ((command === 'add') || (command === 'check')) {
    await commands[command](pathspec, metadata);
    ng.saveMetadata(command);
    return 1;
  }

  if (!argv.driver) {
    const apis = await ng.gather(command, pathspec, argv);
    const len = Object.keys(apis).length;
    if (len) {
      ng.logger.log(len,'API files read');
    }
    ng.populateMetadata(apis, pathspec, argv);
  }
  let candidates = ng.getCandidates(command, pathspec, argv);
  ng.logger.log(candidates.length,'candidates found');

  await ng.runDrivers(argv);
  const leads = ng.trimLeads(candidates); // do here for preferred flags

  if ((command === 'update') && (Object.keys(leads).length)) {
    for (let u in leads) {
      argv.service = leads[u].service;
      if (leads[u].file) {
        argv.cached = path.relative('.',leads[u].file);
      }
      if (leads[u].provider) {
        argv.host = metadata[leads[u].provider].host;
        argv.provider = metadata[leads[u].provider];
        argv.providerKey = leads[u].provider;
      }
      await commands.add(u, metadata);
    }
  }

  if (startUp[command]) {
    candidates = await startUp[command](candidates);
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
    valOpt.patches = 0;
    await commands[command](candidate, metadata);

    //let voa = analyseOpt(valOpt);
    //fs.writeFileSync('./valopt'+count+'.json',JSON.stringify(voa,null,2),'utf8');
    count++;
  }

  if (wrapUp[command]) {
    if (newCandidates.length) await wrapUp[command](newCandidates);
    await wrapUp[command](candidates);
  }

  ng.saveMetadata(command);
  return candidates.length;
}

module.exports = {
  commands,
  defaultPathSpec: ng.defaultPathSpec,
  registerDriver: ng.registerDriver,
  registerCommand,
  main
};

