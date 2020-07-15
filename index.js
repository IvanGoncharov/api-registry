//@ts-check

'use strict';

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');

const deepmerge = require('deepmerge');
const mkdirp = require('mkdirp');
const rf = require('node-readfiles');
const sortobject = require('deep-sort-object');
const yaml = require('yaml');

const now = new Date();
const drivers = new Map(); // map of Maps. drivers -> provider:metadata[p]
const colour = process.env.NODE_DISABLE_COLORS ?
    { red: '', yellow: '', green: '', normal: '' } :
    { red: '\x1b[31m', yellow: '\x1b[33;1m', green: '\x1b[32m', normal: '\x1b[0m' };

let metadata = {};
let apis = {};
const failures = {};

function exec(command) {
  console.log(colour.yellow+command+colour.normal);
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

function fastCommand(command) {
  return ((command === 'ci') || (command == 'add') || (command === 'paths'));
}

const driverFuncs = {
  url: async function(provider,md) {
    // nop
    return true;
  },
  external: async function(provider,md) {
    // nop
    return true;
  },
  apisjson: async function(provider,md) {
    console.log('  ',md.masterUrl);
    // TODO use a generic json catalog driver with a jmespath
    return true;
  },
  html: async function(provider,md) {
    console.log('  ',md.masterUrl);
    // TODO use a cheerio DOM selector and an optional regex for replacement
    return true;
  },
  google: async function(provider,md) {
    console.log('  ',md.masterUrl);
    // may be able to use generic json catalog driver
    return true;
  },
  github: async function(provider,md) {
    console.log('  ',md.masterUrl);
    mkdirp.sync('./metadata/'+provider+'.cache');
    // TODO use fetch and a nodejs tar implementation
    // TODO allow for authentication
    return exec('wget -O- '+md.masterUrl+' | tar -C ./metadata/'+provider+'.cache --wildcards '+md.glob+' -xz');
  }
};

function sortJson(json) {
  json = sortobject(json, function (a, b) {
    if (a === b) return 0;
    return (a < b) ? -1 : 1;
  });

  //detect OpenAPI format
  if (!json.openapi && !json.swagger) {
    return json;
  }

  const fieldOrder = [
    'swagger',
    'schemes',
    'host',
    'basePath',
    'openapi',
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

function saveMetadata() {
  console.log('Saving metadata...');
  let metaStr;
  try {
    metaStr = yaml.stringify(metadata);
  }
  catch (ex) {
    console.warn(colour.red+ex.message+colour.normal);
    try {
      metaStr = JSON.stringify(metadata);
    }
    catch (ex) {
      console.warn(colour.red+ex.message+colour.normal);
    }
  }
  if (metaStr) {
    fs.writeFileSync(path.resolve('.','metadata','registry.yaml'),metaStr,'utf8');
  }
  else {
    fs.writeFileSync(path.resolve('.','metadata','temp.js'),util.inspect(metadata,{depth:Infinity}),'utf8');
  }
  try {
    fs.writeFileSync(path.resolve('.','metadata','failures.yaml'),yaml.stringify(failures),'utf8');
  }
  catch (ex) {
    console.warn(colour.red+ex.message+colour.normal);
  }
  return (typeof metaStr === 'string');
}

async function gather(pathspec, command, slow) {
  console.log('Gathering...');
  apis = {};
  if (fastCommand(command)) return apis;
  let fileArr = await rf(pathspec, { filter: '**/*.yaml', readContents: true, filenameFormat: rf.FULL_PATH }, function(err, filename, content) {
    if ((filename.indexOf('openapi.yaml')>=0) || (filename.indexOf('swagger.yaml')>=0)) {
      const obj = yaml.parse(content);
      const hash = sha256(content);
      if (obj) {
        apis[filename] = { swagger: obj.swagger, openapi: obj.openapi, info: obj.info, hash: hash };
      }
      const fdir = path.dirname(filename);
      if (slow) {
        let patch = {};
        let patchfile = path.join(fdir,'patch.yaml');
        if (fs.existsSync(patchfile)) {
          patch = yaml.parse(fs.readFileSync(patchfile,'utf8'));
        }
        patchfile = path.join(fdir,'..','patch.yaml');
        if (fs.existsSync(patchfile)) {
          patch = deepmerge(patch,yaml.parse(fs.readFileSync(patchfile,'utf8')));
        }
        patchfile = path.join(fdir,'..','..','patch.yaml');
        if (fs.existsSync(patchfile)) {
          patch = deepmerge(patch,yaml.parse(fs.readFileSync(patchfile,'utf8')));
        }
        if (Object.keys(patch).length) apis[filename].patch = patch;
      }
    }
  });
  return apis;
}

function populateMetadata(apis) {

  for (let provider in metadata) {
    for (let service in metadata[provider].apis) {
      for (let version in metadata[provider].apis[service]) {
        metadata[provider].apis[service][version].run = false;
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
    if (serviceName) comp.pop();
    comp.pop(); // providerName
    const filepath = comp.join('/');
    const origin = clone(api.info['x-origin']) || [ {} ];
    const source = origin.pop();
    const history = api.info['x-origin'];
    const entry = { name, openapi, preferred, filename, source, history, hash: api.hash, run: true, runDate: now };
    if (api.patch && Object.keys(api.patch).length) {
      entry.patch = api.patch;
    }

    if (!metadata[providerName]) metadata[providerName] = { driver: 'url', apis: {} };
    if (!metadata[providerName].apis[serviceName]) metadata[providerName].apis[serviceName] = {};
    if (!metadata[providerName].apis[serviceName][version]) metadata[providerName].apis[serviceName][version] = {};

    metadata[providerName].apis[serviceName][version] = Object.assign({},metadata[providerName].apis[serviceName][version],entry);
    if (!metadata[providerName].apis[serviceName][version].added) {
      metadata[providerName].apis[serviceName][version].added = now;
    }

    let driverProviders = drivers.get(metadata[providerName].driver);
    if (driverProviders) {
      driverProviders.set(providerName,metadata[providerName]);
    }
    else {
      const providers = new Map();
      providers.set(providerName,metadata[providerName]);
      drivers.set(metadata[providerName].driver,providers);
    }
  }
  return metadata;
}

async function runDrivers(only) {
  for (let driver of drivers.keys()) {
    const providers = drivers.get(driver);
    for (let provider of providers.keys()) {
      if (!only || driver === only) {
        console.log('Running driver',driver,'for',provider);
        await driverFuncs[driver](provider,providers.get(provider));
      }
    }
  }
  return drivers;
}

function getCandidates(driver, override) {
  const result = [];

  for (let provider in metadata) {
    for (let service in metadata[provider].apis) {
      for (let version in metadata[provider].apis[service]) {
        if ((driver && driver === metadata[provider].driver) || metadata[provider].apis[service][version].run || override) {
          const entry = { provider, driver: metadata[provider].driver, service, version, parent: metadata[provider].apis[service], md: metadata[provider].apis[service][version] };
          entry.info = apis[entry.md.filename].info;
          result.push(entry);
        }
      }
    }
  }

  return result;
}

module.exports = {
  colour,
  sortJson,
  clone,
  exec,
  sha256,
  fail,
  fastCommand,
  now,
  loadMetadata,
  saveMetadata,
  gather,
  populateMetadata,
  runDrivers,
  getCandidates
};

