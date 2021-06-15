//@ts-check

'use strict';

// TODO logging websocket support for API mode?

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const streamPipeline = util.promisify(require('stream').pipeline);

const fetch = require('fetch-filecache-for-crawling');
const jmespath = require('jmespath').search;
const mkdirp = require('mkdirp');
const rf = require('node-readfiles');
const sortobject = require('deep-sort-object');
const yaml = require('yaml');
const tar = require('tar');
const puppeteer = require('puppeteer');
const zip = require('adm-zip');

yaml.defaultOptions = { prettyErrors: true };

const now = new Date();
const drivers = new Map(); // map of Maps. drivers -> provider:metadata[p]
const colour = process.env.NODE_DISABLE_COLORS ?
    { red: '', yellow: '', green: '', normal: '', clear: '' } :
    { red: '\x1b[31m', yellow: '\x1b[33;1m', green: '\x1b[32m', normal: '\x1b[0m', clear: '\r\x1b[1M' };

// cacheFolder constants
const indexCache = path.resolve('.','metadata','index.cache');
const archiveCache = path.resolve('.','metadata','archive.cache');

let metadata = {};
let metadataConsistent = false;
let apis = {};
let leads = {};
let browser;

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

// based on https://hacks.mozilla.org/2015/07/es6-in-depth-proxies-and-reflect/
function Tree(base = {}) {
  return new Proxy(base, treeHandler);
}

const treeHandler = {
  get: function (target, key, receiver) {
    if (!(key in target) && key !== 'toJSON' && key !== '$$typeof' && key !== Symbol.iterator) {
      target[key] = Tree(); // auto-create a sub-Tree
    }
    return Reflect.get(target, key, receiver);
  }
};

const failures = Tree();

function exec(command) {
  logger.log(colour.yellow+command+colour.normal);
  return cp.execSync(command);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function fail(candidate,status,err,context) {
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
    logger.log('  ',md.mainUrl);
    const res = await fetch(md.mainUrl, { cacheFolder: indexCache });
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
  blob: async function(provider,md) {
    if (!browser) browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(md.mainUrl, { waitUntil: 'networkidle0' });

    await page.waitForSelector('a[download]', {
      visible: true,
    });

    const elementHandles = await page.$$('a[download]');
    await Promise.all(
      elementHandles.map(handle => handle.click())
    );
    const propertyJsHandles = await Promise.all(
      elementHandles.map(handle => handle.getProperty('href'))
    );
    const hrefs = await Promise.all(
      propertyJsHandles.map(handle => handle.jsonValue())
    );

    let result;
    md.data = [];
    for (let href of hrefs) {
      if (href.startsWith('blob:')) {
        await page.goto(href, { waitUntil: 'networkidle2' });
        let text = await page.content();
        if (text.indexOf('<pre')>=0) {
          text = '{'+(text.split('>{')[1].split('</pre>')[0]);
        }
        const components = href.split('/');
        components.pop(); // remove last identifier section of url
        components.push('blobId');
        md.data.push({ url: components.join('/'), text });
      }
    }
    return true;
  },
  catalog: async function(provider,md) {
    md.data = [];
    logger.log('  ',md.mainUrl);
    const res = await fetch(md.mainUrl, { cacheFolder: indexCache });
    const catalog = await res.json();
    const services = jmespath(catalog, md.serviceQuery);
    const urls = jmespath(catalog, md.urlQuery);
    let dataItems = [];
    if (md.dataQuery) {
      dataItems = jmespath(catalog, md.dataQuery);
    }
    for (let u in urls) {
      if (Array.isArray(urls[u])) urls[u] = urls[u][0];
      urls[u] = new URL(urls[u], md.mainUrl).toString();
    }
    for (let i=0;i<services.length;i++) {
      let serv = services[i];
      if (Array.isArray(serv)) serv = serv[0];
      leads[urls[i]] = { service: serv.toLowerCase(), provider };
      if (dataItems[i]) {
        md.data.push({ url: urls[i], text: JSON.stringify(dataItems[i]) });
      }
    }
    return true;
  },
  html: async function(provider,md) {
    logger.log('  ',md.mainUrl);
    // TODO use a cheerio DOM selector and an optional regex for replacement
    return true;
  },
  google: async function(provider,md) {
    logger.log('  ',md.mainUrl);
    const res = await fetch(md.mainUrl, { cacheFolder: indexCache });
    const discovery = await res.json();
    for (let item of discovery.items) {
      leads[item.discoveryRestUrl] = { service: item.name };
    }
    return true;
  },
  github: async function(provider,md) {
    // TODO support GitHub action artifacts (download via API)
    // https://docs.github.com/en/rest/reference/actions#artifacts
    logger.log('  ',md.org,md.repo,md.branch,md.glob);
    await mkdirp(`./metadata/${provider}.cache`);
    // TODO allow for authentication
    const codeloadUrl = `https://codeload.github.com/${md.org}/${md.repo}/tar.gz/${md.branch}`;
    const res = await fetch(codeloadUrl, { cacheFolder: archiveCache });
    const tarx = tar.x({ strip: 1, C: `./metadata/${provider}.cache` });
    res.body.pipe(tarx);
    const fileArr = await rf(`./metadata/${provider}.cache/`, { filter: md.glob, readContents: false, filenameFormat: rf.RELATIVE });
    for (let file of fileArr) {
      const fileUrl = `https://raw.githubusercontent.com/${md.org}/${md.repo}/${md.branch}/${file}`;
      // TODO way to extract service can differ between providers
      let service = path.basename(file,path.extname(file));
      service = service.split('-v')[0];
      if (file.indexOf('deref')<0) { // FIXME hardcoded
        leads[fileUrl] = { file: path.resolve('.','metadata',provider+'.cache',file), service, provider };
      }
    }
    return true;
  },
  zip: async function(provider,md) {
    md.data = [];
    for (let u of md.mainUrl) {
      logger.log(colour.green,u);
      const res = await fetch(u, { cacheFolder: archiveCache });
      if (!res.ok) {
        logger.warn(colour.red,res.statusText,colour.normal);
      }
      else {
        const zipFileName = path.resolve(archiveCache,`${provider}.zip`);
        await streamPipeline(res.body, fs.createWriteStream(zipFileName));
        const zipFile = new zip(zipFileName);
	    zipFile.getEntries().forEach(function(zipEntry) {
           if (zipEntry.name.endsWith('.json')) {
             const temp = zipEntry.getData().toString('utf8');
             if (typeof temp === 'string' && temp.startsWith('{')) {
               logger.log(colour.yellow,zipEntry.entryName,colour.normal);
               md.data.push({ url: zipEntry.entryName, text: temp });
             }
           }
        });
	  }
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
  if (typeof o === 'undefined') return;
  return JSON.parse(JSON.stringify(o));
}

function cleanseVersion(v) {
  return v.split('/').join('-').split('\\').join('-').split(':').join('');
}

function loadMetadata() {
  const metaStr = fs.readFileSync(path.resolve('.','metadata','registry.yaml'),'utf8');
  metadata = yaml.parse(metaStr);
  return metadata;
}

function saveMetadata(command) {
  if (metadataConsistent) return true;
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
    logger.warn(colour.red+ex.message+colour.normal,'writing failures');
    console.error(ex);
    process.exitCode = 3;
  }
  const result = (typeof metaStr === 'string');
  if (result) metadataConsistent = true;
  if (browser) {
    browser.close();
    browser = null;
  }
  return result;
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
    }
  });
  return apis;
}

function populateMetadata(apis, pathspec, argv) {

  if (Object.keys(apis).length === 0) {
    for (let provider in metadata) {
      for (let service in metadata[provider].apis) {
        for (let version in metadata[provider].apis[service]) {
          if (version !== 'patch') {
            let md = metadata[provider].apis[service][version];
            if (md.filename && md.filename.startsWith(pathspec)) {
              if (!argv.small || Object.keys(metadata[provider].apis).length < 50) {
                md.run = now;
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
    const entry = { name, openapi, preferred, unofficial, filename, source, history, hash: api.hash, run: now };

    if (!metadata[providerName]) metadata[providerName] = Tree({ driver: 'url', apis: {} });
    if (api.parentPatch && Object.keys(api.parentPatch).length) {
      metadata[providerName].patch = api.parentPatch;
    }
    //if (!metadata[providerName].apis[serviceName]) metadata[providerName].apis[serviceName] = {};
    if (api.patch && Object.keys(api.patch).length) {
      metadata[providerName].apis[serviceName].patch = api.patch;
    }
    //if (!metadata[providerName].apis[serviceName][version]) metadata[providerName].apis[serviceName][version] = {};

    metadata[providerName].apis[serviceName][version] = Object.assign({},metadata[providerName].apis[serviceName][version],entry);
    if (!metadata[providerName].apis[serviceName][version].added) {
      metadata[providerName].apis[serviceName][version].added = now;
    }
    delete metadata[providerName].apis[serviceName][version].patch; // temp FIXME (removing patches at version level)
  }
  return metadata;
}

async function runDrivers(argv) {
  if (argv.skipDrivers) return {};
  for (let driver of drivers.keys()) {
    const providers = drivers.get(driver);
    for (let provider of providers.keys()) {
      if (!argv.rriver || driver === argv.driver) {
        logger.log('Running driver',driver,'for',provider);
        await driverFuncs[driver](provider,providers.get(provider));
      }
    }
  }
  return drivers;
}

function getCandidates(argv) {
  const returnAll = (argv.driver === 'none');
  const driver = (returnAll ? undefined : argv.driver);
  const result = [];

  for (let provider in metadata) {
    for (let service in metadata[provider].apis) {
      for (let version in metadata[provider].apis[service]) {
        if (version !== 'patch') {
          if (returnAll || (driver && driver === metadata[provider].driver) || (!driver && metadata[provider].apis[service][version].run === now)) {
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
  Tree,
  colour,
  logger,
  sortJson,
  clone,
  cleanseVersion,
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

