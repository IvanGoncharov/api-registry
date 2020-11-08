//@ts-check

'use strict';

// TODO logging ws support for API?

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');

const fetch = require('fetch-filecache-for-crawling');
const jmespath = require('jmespath').search;
const mkdirp = require('mkdirp');
const rf = require('node-readfiles');
const sortobject = require('deep-sort-object');
const yaml = require('yaml');

const now = new Date();
const drivers = new Map(); // map of Maps. drivers -> provider:metadata[p]
const colour = process.env.NODE_DISABLE_COLORS ?
    { red: '', yellow: '', green: '', normal: '', clear: '' } :
    { red: '\x1b[31m', yellow: '\x1b[33;1m', green: '\x1b[32m', normal: '\x1b[0m', clear: '\x1b[1M' };
const indexCache = path.resolve('.','metadata','index.cache');

let metadata = {};
let apis = {};
let leads = {};
const failures = {};

let logger = {
  prepend(s) {
    process.stdout.write(s);
  },
  log(...p) {
    console.log(...p);
  },
  warn(...p) {
    console.warn(...p);
  },
  error(...p) {
    console.error(...p);
  }
};

function exec(command) {
  logger.log(colour.yellow+command+colour.normal);
  return cp.execSync(command);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function fail(candidate,status,err,context) {
  if (!failures[candidate.provider]) {
    failures[candidate.provider] = {};
  }
  if (!failures[candidate.provider][candidate.service]) {
    failures[candidate.provider][candidate.service] = {};
  }
  failures[candidate.provider][candidate.service][candidate.version] =
    { status, err:(err ? err.message : ''), context };
}

function slowCommand(command) {
  return (command === 'populate');
}

const driverFuncs = {
  nop: async function(provider,md) {
    // nop
    return true;
  },
  url: async function(provider,md) {
    // nop
    return true;
  },
  external: async function(provider,md) {
    // nop
    return true;
  },
  apisjson: async function(provider,md) {
    logger.log('  ',md.masterUrl);
    const res = await fetch(md.masterUrl, { cacheFolder: indexCache });
    const apisjson = await res.json();
    for (let api of apisjson.apis) {
      for (let property of api.properties) {
        if (property.type === 'Swagger') {
          const serviceName = property.url.split('/').pop().replace('.json','');
          leads[property.url] = { service: serviceName };
        }
      }
    }
    return true;
  },
  catalog: async function(provider,md) {
    logger.log('  ',md.masterUrl);
    const res = await fetch(md.masterUrl, { cacheFolder: indexCache });
    const catalog = await res.json();
    const services = jmespath(catalog, md.serviceQuery);
    const urls = jmespath(catalog, md.urlQuery);
    for (let u in urls) {
      urls[u] = new URL(urls[u][0], md.masterUrl).toString();
    }
    for (let i=0;i<services.length;i++) {
      leads[urls[i]] = { service: services[i][0] };
    }
    return true;
  },
  html: async function(provider,md) {
    logger.log('  ',md.masterUrl);
    // TODO use a cheerio DOM selector and an optional regex for replacement
    return true;
  },
  google: async function(provider,md) {
    logger.log('  ',md.masterUrl);
    const res = await fetch(md.masterUrl, { cacheFolder: indexCache });
    const discovery = await res.json();
    for (let item of discovery.items) {
      leads[item.discoveryRestUrl] = { service: item.name };
    }
    return true;
  },
  github: async function(provider,md) {
    logger.log('  ',md.org,md.repo,md.branch,md.glob);
    await mkdirp(`./metadata/${provider}.cache`);
    // TODO use fetch and a nodejs tar implementation
    // TODO allow for authentication
    const codeloadUrl = `https://codeload.github.com/${md.org}/${md.repo}/tar.gz/${md.branch}`;
    exec(`wget -O- ${codeloadUrl} | tar -C ./metadata/${provider}.cache --wildcards ${md.repo}-${md.branch}/${md.glob} -xz`);
    const fileArr = await rf(`./metadata/${provider}.cache/${md.repo}-${md.branch}`, { filter: md.glob, readContents: false, filenameFormat: rf.RELATIVE });
    for (let file of fileArr) {
      const fileUrl = `https://raw.githubusercontent.com/${md.org}/${md.repo}/${md.branch}/${file}`;
      // TODO way to extract service can differ between providers
      let service = path.basename(file,path.extname(file));
      service = service.split('-v')[0];
      leads[fileUrl] = { file: path.resolve('.','metadata',provider+'.cache',md.repo+'-'+md.branch,file), service };
    }
    return true;
  }
};

function registerDriver(drv) {
  driverFuncs[drv.name] = drv.run;
}

function sortJson(json) {
  json = sortobject(json, function (a, b) {
    if (a === b) return 0;
    return (a < b) ? -1 : 1;
  });

  //detect OpenAPI format
  if (!json.openapi && !json.swagger && !json.asyncapi) {
    return json;
  }

  const fieldOrder = [
    'swagger',
    'schemes',
    'host',
    'basePath',
    'openapi',
    'asyncapi',
    'id',
    'servers',
    'x-hasEquivalentPaths',
    'info',
    'externalDocs',
    'consumes',
    'produces',
    'securityDefinitions',
    'security',
    'parameters',
    'responses',
    'tags',
    'paths',
    'baseTopic',
    'topics',
    'channels',
    'definitions',
    'components'
  ];

  let sorted = {};
  fieldOrder.forEach(function(name) {
    if (typeof json[name] === 'undefined') return;
    sorted[name] = json[name];
    delete json[name];
  });
  sorted = Object.assign(sorted, json);
  return sorted;
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function loadMetadata() {
  const metaStr = fs.readFileSync(path.resolve('.','metadata','registry.yaml'),'utf8');
  metadata = yaml.parse(metaStr);
  return metadata;
}

function saveMetadata(command) {
  logger.log('Saving metadata...');
  if (command === 'add') {
    metadata = sortobject(metadata);
  }
  let metaStr;
  try {
    metaStr = yaml.stringify(metadata,{prettyErrors:true});
  }
  catch (ex) {
    logger.warn(colour.red,ex,colour.normal);
    try {
      metaStr = JSON.stringify(metadata,null,2);
    }
    catch (ex) {
      logger.warn(colour.red+ex.message+colour.normal);
    }
  }
  if (metaStr) {
    fs.writeFileSync(path.resolve('.','metadata','registry.yaml'),metaStr,'utf8');
  }
  else {
    fs.writeFileSync(path.resolve('.','metadata','temp.js'),util.inspect(metadata,{depth:Infinity}),'utf8');
  }
  try {
    fs.writeFileSync(path.resolve('.','metadata',command+'_failures.yaml'),yaml.stringify(failures),'utf8');
  }
  catch (ex) {
    logger.warn(colour.red+ex.message+colour.normal);
  }
  return (typeof metaStr === 'string');
}

async function gather(pathspec, command, argv) {
  apis = {};
  if (!slowCommand(command)) return apis;
  logger.log('Gathering...');
  let fileArr = await rf(pathspec, { filter: '**/*.yaml', readContents: true, filenameFormat: rf.FULL_PATH }, function(err, filename, content) {
    if ((filename.indexOf('openapi.yaml')>=0) || (filename.indexOf('swagger.yaml')>=0)) {
      const obj = yaml.parse(content);
      const hash = sha256(content);
      if (obj) {
        apis[filename] = { swagger: obj.swagger, openapi: obj.openapi, info: obj.info, hash: hash };
      }
      const fdir = path.dirname(filename);
      if (argv.patch) { // TODO can be removed when separate patch files removed
        let patchfile = path.join(fdir,'..','patch.yaml');
        if (fs.existsSync(patchfile)) {
          const patch = yaml.parse(fs.readFileSync(patchfile,'utf8'));
          if (Object.keys(patch).length) apis[filename].parentPatch = patch;
        }
        patchfile = path.join(fdir,'..','..','patch.yaml');
        if (fs.existsSync(patchfile)) {
          const patch = yaml.parse(fs.readFileSync(patchfile,'utf8'));
          if (Object.keys(patch).length) apis[filename].patch = patch;
        }
      }
    }
  });
  return apis;
}

function populateMetadata(apis, pathspec, argv) {

  for (let provider in metadata) {
    for (let service in metadata[provider].apis) {
      for (let version in metadata[provider].apis[service]) {
        if (version !== 'patch') {
          metadata[provider].apis[service][version].run = false;
        }
      }
    }
  }

  if (Object.keys(apis).length === 0) {
    for (let provider in metadata) {
      for (let service in metadata[provider].apis) {
        for (let version in metadata[provider].apis[service]) {
          if (version !== 'patch') {
            let md = metadata[provider].apis[service][version];
            if (md.filename && md.filename.startsWith(pathspec)) {
              if (!argv.small || Object.keys(metadata[provider].apis).length < 50) {
                md.run = true;
              }
            }
          }
        }
      }
    }
  }

  for (let filename in apis) {
    const api = apis[filename];
    filename = path.relative('.',filename);
    const comp = filename.split('/');
    const name = comp.pop();
    const openapi = api.openapi ? api.openapi : api.swagger;
    const version = comp.pop();
    const serviceName = api.info['x-serviceName'] ? api.info['x-serviceName'] : '';
    const providerName = api.info['x-providerName'];
    const preferred = (typeof api.info['x-preferred'] === 'boolean') ? api.info['x-preferred'] : undefined;
    const unofficial = !!api.info['x-unofficialSpec'];
    if (serviceName) comp.pop();
    comp.pop(); // providerName
    const filepath = comp.join('/');
    const origin = clone(api.info['x-origin']) || [ {} ]; // clone so we don't affect API object itself
    const source = origin.pop();
    const history = origin; // what's left
    const entry = { name, openapi, preferred, unofficial, filename, source, history, hash: api.hash, run: true, runDate: now };

    if (!metadata[providerName]) metadata[providerName] = { driver: 'url', apis: {} };
    if (api.parentPatch && Object.keys(api.parentPatch).length) {
      metadata[providerName].patch = api.parentPatch;
    }
    if (!metadata[providerName].apis[serviceName]) metadata[providerName].apis[serviceName] = {};
    if (api.patch && Object.keys(api.patch).length) {
      metadata[providerName].apis[serviceName].patch = api.patch;
    }
    if (!metadata[providerName].apis[serviceName][version]) metadata[providerName].apis[serviceName][version] = {};

    metadata[providerName].apis[serviceName][version] = Object.assign({},metadata[providerName].apis[serviceName][version],entry);
    if (!metadata[providerName].apis[serviceName][version].added) {
      metadata[providerName].apis[serviceName][version].added = now;
    }
    delete metadata[providerName].apis[serviceName][version].patch; // temp FIXME
  }
  return metadata;
}

async function runDrivers(selectedDriver) {
  for (let driver of drivers.keys()) {
    const providers = drivers.get(driver);
    for (let provider of providers.keys()) {
      if (!selectedDriver || driver === selectedDriver) {
        logger.log('Running driver',driver,'for',provider);
        await driverFuncs[driver](provider,providers.get(provider));
      }
    }
  }
  return drivers;
}

function getCandidates(argv) {
  const driver = argv.driver;
  const result = [];

  for (let provider in metadata) {
    for (let service in metadata[provider].apis) {
      for (let version in metadata[provider].apis[service]) {
        if (version !== 'patch') {
          if ((driver && driver === metadata[provider].driver) || (!driver && metadata[provider].apis[service][version].run)) {
            const entry = { provider, driver: metadata[provider].driver, service, version, parent: metadata[provider].apis[service], gp: metadata[provider], md: metadata[provider].apis[service][version] };
            if (apis[entry.md.filename]) entry.info = apis[entry.md.filename].info;
            result.push(entry);
            let driverProviders = drivers.get(metadata[provider].driver);
            if (driverProviders) {
              driverProviders.set(provider,metadata[provider]);
            }
            else {
              const providers = new Map();
              providers.set(provider,metadata[provider]);
              drivers.set(metadata[provider].driver,providers);
            }
          }
        }
      }
    }
  }

  return result;
}

function trimLeads(candidates) {
  if (Object.keys(leads).length) {
    for (let candidate of candidates) {
      if (leads[candidate.md.source.url]) {
        candidate.md.cached = leads[candidate.md.source.url].file;
        delete leads[candidate.md.source.url];
      }
    }
  }
  const leadsLen = Object.keys(leads).length;
  if (leadsLen) {
    logger.log(leadsLen,'new leads');
  }
  return leads;
}

module.exports = {
  colour,
  logger,
  sortJson,
  clone,
  exec,
  sha256,
  fail,
  now,
  loadMetadata,
  saveMetadata,
  registerDriver,
  gather,
  populateMetadata,
  runDrivers,
  getCandidates,
  trimLeads
};

