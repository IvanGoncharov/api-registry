const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify, inspect } = require('node:util');
const streamPipeline = promisify(require('node:stream').pipeline);

const fetch = require('fetch-filecache-for-crawling');
const jmespath = require('jmespath').search;
const mkdirp = require('mkdirp');
const rf = require('node-readfiles');
const sortobject = require('sortobject').default;
const yaml = require('yaml');
const tar = require('tar');
const puppeteer = require('puppeteer');
const zip = require('adm-zip');

const now = new Date().toISOString(); // now is a string because it is used to compare to strings in the registry
const weekAgo = new Date(new Date().setDate(new Date().getDate() - 7)); // weekAgo is a date because it is used in date calculations
const drivers = new Map(); // map of Maps. drivers -> provider:metadata[p]
const colour = process.env.NODE_DISABLE_COLORS
  ? { red: '', yellow: '', green: '', normal: '', clear: '' }
  : {
      red: '\u001B[31m',
      yellow: '\u001B[33;1m',
      green: '\u001B[32m',
      normal: '\u001B[0m',
      clear: '\r\u001B[1M',
    };
const defaultPathSpec = path.relative('.', 'APIs');

// cacheFolder constants
const indexCache = path.resolve('.', 'metadata', 'index.cache');
const archiveCache = path.resolve('.', 'metadata', 'archive.cache');

let metadata = {};
let metadataConsistent = false;
let apis = {};
let leads = {};
let browser;

function yamlParse(str) {
  return yaml.parse(str, { prettyErrors: true, logLevel: 'error' });
}

function yamlStringify(obj) {
  return yaml.stringify(obj, {
    prettyErrors: true,
    logLevel: 'error',
    lineWidth: 0,
  });
}

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
  },
};

// based on https://hacks.mozilla.org/2015/07/es6-in-depth-proxies-and-reflect/
function Tree(base = {}) {
  return new Proxy(base, treeHandler);
}

const treeHandler = {
  get(target, key, receiver) {
    if (
      !(key in target) &&
      key !== 'toJSON' &&
      key !== '$$typeof' &&
      key !== Symbol.iterator
    ) {
      target[key] = Tree(); // auto-create a sub-Tree
    }
    return Reflect.get(target, key, receiver);
  },
};

const failures = Tree();

function exec(command) {
  logger.log(colour.yellow + command + colour.normal);
  return cp.execSync(command);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function fail(candidate, status, err, context) {
  failures[candidate.provider][candidate.service][candidate.version] = {
    status,
    error: err ? err.message : '',
    context,
  };
  process.exitCode = 1;
}

const driverFuncs = {
  // TODO add swaggerhub driver, using endpoint
  // https://api.swaggerhub.com/apis/{owner}/{api}/settings/default

  async nop(_provider, _md) {
    // nop
    return true;
  },
  async url(_provider, _md) {
    // nop
    return true;
  },
  async external(_provider, _md) {
    // nop
    return true;
  },
  async apisjson(provider, md) {
    logger.log('  ', md.mainUrl);
    const res = await fetch(md.mainUrl, { cacheFolder: indexCache });
    const apisjson = await res.json();
    for (let api of apisjson.apis) {
      for (let property of api.properties) {
        if (property.type === 'Swagger') {
          const serviceName = property.url
            .split('/')
            .pop()
            .replace('.json', '');
          leads[property.url] = { service: serviceName };
        }
      }
    }
    return true;
  },
  async blob(provider, md) {
    if (!browser) browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(md.mainUrl, { waitUntil: 'networkidle0' });

    await page.waitForSelector('a[download]', {
      visible: true,
    });

    const elementHandles = await page.$$('a[download]');
    await Promise.all(elementHandles.map((handle) => handle.click()));
    const propertyJsHandles = await Promise.all(
      elementHandles.map((handle) => handle.getProperty('href')),
    );
    const hrefs = await Promise.all(
      propertyJsHandles.map((handle) => handle.jsonValue()),
    );

    md.data = [];
    for (let href of hrefs) {
      if (href.startsWith('blob:')) {
        await page.goto(href, { waitUntil: 'networkidle2' });
        let text = await page.content();
        if (text.includes('<pre')) {
          text = '{' + text.split('>{')[1].split('</pre>')[0];
        }
        const components = href.split('/');
        components.pop(); // remove last identifier section of url
        components.push('blobId');
        const blobUrl = components.join('/');
        logger.log(blobUrl);
        md.data.push({ url: blobUrl, text });
      }
    }
    return true;
  },
  async catalog(provider, md) {
    md.data = [];
    logger.log('  ', md.mainUrl);
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
    for (let [i, serv] of services.entries()) {
      if (Array.isArray(serv)) serv = serv[0];
      if (typeof serv === 'string') serv = serv.toLowerCase();
      leads[urls[i]] = { service: serv, provider };
      if (dataItems[i]) {
        md.data.push({ url: urls[i], text: JSON.stringify(dataItems[i]) });
      }
    }
    return true;
  },
  async html(provider, md) {
    logger.log('  ', md.mainUrl);
    // TODO use a cheerio DOM selector and an optional regex for replacement
    return true;
  },
  async google(provider, md) {
    logger.log('  ', md.mainUrl);
    const res = await fetch(md.mainUrl, { cacheFolder: indexCache });
    const discovery = await res.json();
    for (let item of discovery.items) {
      leads[item.discoveryRestUrl] = {
        service: item.name,
        preferred: item.preferred,
      };
    }
    return true;
  },
  async github(provider, md) {
    // TODO support GitHub action artifacts (download via API)
    // https://docs.github.com/en/rest/reference/actions#artifacts
    logger.log('  ', md.org, md.repo, md.branch, md.glob);
    await mkdirp(`./metadata/${provider}.cache`);
    // TODO allow for authentication
    const codeloadUrl = `https://codeload.github.com/${md.org}/${md.repo}/tar.gz/${md.branch}`;
    const res = await fetch(codeloadUrl, { cacheFolder: archiveCache });
    if (res.ok) {
      const tarx = tar.x({ strip: 1, C: `./metadata/${provider}.cache` });
      const stream = res.body.pipe(tarx);
      stream.on('warn', (code, message) => {
        logger.warn('tar !', message);
      });
      stream.on('entry', (entry) => {
        if (md.verbose) logger.log('tar x', entry.header.path);
      });
      await new Promise((fulfill) => stream.on('finish', fulfill));
      const fileArr = await rf(`./metadata/${provider}.cache/`, {
        filter: md.glob,
        readContents: false,
        filenameFormat: rf.RELATIVE,
      });
      let count = 0;
      for (let file of fileArr) {
        const fileUrl = `https://raw.githubusercontent.com/${md.org}/${md.repo}/${md.branch}/${file}`;
        // TODO way to extract service can differ between providers
        let service = path.basename(file, path.extname(file));
        if (md.pop || md.shift) {
          const components = file.split('/');
          if (md.shift)
            for (let i = 0; i < md.shift; i++) {
              components.shift(md.shift);
            }
          if (md.pop)
            for (let i = 0; i < md.pop; i++) {
              components.pop(md.pop);
            }
          service = components.join('/');
        }
        if (md.regex) {
          const re = new RegExp(md.regex, 'gm');
          service.replace(re, (match, group1) => {
            service = group1;
            return group1;
          });
          service = service.split(' ').join('-');
        } else if (md.split) {
          service = service.split(md.split || '-v')[0];
        }
        if (!file.includes('deref')) {
          count++;
          leads[fileUrl] = {
            file: path.resolve('.', 'metadata', provider + '.cache', file),
            service,
            provider,
          };
        }
      }
      logger.log(`   ${count} files found from archive`);
      return true;
    } else {
      logger.warn(`   Received status code ${res.status}`);
      return false;
    }
  },
  async zip(provider, md) {
    md.data = [];
    for (let u of md.mainUrl) {
      logger.log(colour.green, u);
      const res = await fetch(u, { cacheFolder: archiveCache });
      if (res.ok) {
        const zipFileName = path.resolve(archiveCache, `${provider}.zip`);
        await streamPipeline(res.body, fs.createWriteStream(zipFileName));
        const zipFile = new zip(zipFileName);
        for (const zipEntry of zipFile.getEntries()) {
          if (zipEntry.name.endsWith('.json')) {
            const temp = zipEntry.getData().toString('utf8');
            if (typeof temp === 'string' && temp.startsWith('{')) {
              logger.log(colour.yellow, zipEntry.entryName, colour.normal);
              md.data.push({ url: zipEntry.entryName, text: temp });
            }
          }
        }
      } else {
        logger.warn(colour.red, res.statusText, colour.normal);
      }
    }
    return true;
  },
};

function sortJson(json) {
  json = sortobject(json);

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
    'components',
  ];

  let sorted = {};
  for (const name of fieldOrder) {
    if (json[name] === undefined) continue;
    sorted[name] = json[name];
    delete json[name];
  }
  sorted = Object.assign(sorted, json);
  return sorted;
}

function clone(o) {
  if (o === undefined) return;
  return structuredClone(o);
}

function cleanseVersion(v) {
  return v
    .split('/')
    .join('-')
    .split('\\')
    .join('-')
    .split(':')
    .join('')
    .split('.*')
    .join('');
}

function loadMetadata(command) {
  const metaStr = fs.readFileSync(
    path.resolve('.', 'metadata', 'registry.yaml'),
    'utf8',
  );
  metadata = yamlParse(metaStr);
  if (['ci', 'deploy'].includes(command)) {
    metadata = sortobject(metadata);
  }
  return metadata;
}

function saveMetadata(command) {
  if (process.exitCode === 1 && command === 'update') process.exitCode = 0;
  if (process.exitCode === 99) process.exitCode = 0;
  if (metadataConsistent) return true;
  logger.log('Saving metadata...');
  if (command === 'sort') {
    metadata = sortobject(metadata);
  }
  for (let provider in metadata) {
    delete metadata[provider].data;
  }
  let metaStr;
  try {
    metaStr = yamlStringify(metadata);
  } catch (error) {
    logger.warn(colour.red, error, colour.normal);
    try {
      metaStr = JSON.stringify(metadata, undefined, 2);
    } catch (error) {
      logger.warn(colour.red + error.message + colour.normal);
    }
  }
  if (metaStr) {
    fs.writeFileSync(
      path.resolve('.', 'metadata', 'registry.yaml'),
      metaStr,
      'utf8',
    );
  } else {
    fs.writeFileSync(
      path.resolve('.', 'metadata', 'temp.js'),
      inspect(metadata, { depth: Infinity }),
      'utf8',
    );
  }
  try {
    fs.writeFileSync(
      path.resolve('.', 'metadata', command + '_failures.yaml'),
      yamlStringify(failures),
      'utf8',
    );
  } catch (error) {
    logger.warn(colour.red + error.message + colour.normal, 'writing failures');
    console.error(error);
    process.exitCode = 3;
  }
  const result = typeof metaStr === 'string';
  if (result) metadataConsistent = true;
  if (browser) {
    browser.close();
    browser = undefined;
  }
  return result;
}

async function gather(command, pathspec) {
  apis = {};
  if (!pathspec || pathspec === defaultPathSpec) return apis;
  logger.log(`Gathering from ${pathspec}`);
  try {
    await rf(
      pathspec,
      { filter: '**/*.yaml', readContents: true, filenameFormat: rf.FULL_PATH },
      (err, filename, content) => {
        if (
          filename.includes('openapi.yaml') ||
          filename.includes('swagger.yaml')
        ) {
          const obj = yamlParse(content);
          const hash = sha256(content);
          if (obj) {
            apis[filename] = {
              swagger: obj.swagger,
              openapi: obj.openapi,
              info: obj.info,
              hash: hash,
            };
          }
        }
      },
    );
  } catch {
    logger.warn(`Pathspec not found ${pathspec}`);
  }
  return apis;
}

function populateMetadata(apis, pathspec, argv) {
  if (Object.keys(apis).length === 0) {
    // if fast processing all APIs
    logger.log(`Default pathspec ${pathspec}`);
    for (let provider in metadata) {
      for (let service in metadata[provider].apis) {
        for (let version in metadata[provider].apis[service]) {
          if (version !== 'patch') {
            let md = metadata[provider].apis[service][version];
            if (
              md.filename?.startsWith(pathspec) &&
              (!argv.small || Object.keys(metadata[provider].apis).length < 50)
            ) {
              md.run = now;
            }
          }
        }
      }
    }
  }

  for (let filename in apis) {
    const api = apis[filename];
    filename = path.relative('.', filename);
    const comp = filename.split('/');
    const name = comp.pop();
    const openapi = api.openapi ?? api.swagger;
    let version = comp.pop();
    const serviceName = api.info['x-serviceName'] ?? '';
    const providerName = api.info['x-providerName'];
    const preferred = api.info['x-preferred'];
    const unofficial = api.info['x-unofficialSpec'];
    if (serviceName) comp.pop();
    comp.pop(); // providerName
    const origin = clone(api.info['x-origin']) || [{}]; // clone so we don't affect API object itself
    const source = origin.pop();
    const history = origin; // what's left
    const entry = {
      name,
      openapi,
      preferred,
      unofficial,
      filename,
      source,
      history,
      hash: api.hash,
      run: now,
    };

    if (!metadata[providerName])
      metadata[providerName] = Tree({ driver: 'url', apis: {} });
    if (api.parentPatch && Object.keys(api.parentPatch).length > 0) {
      metadata[providerName].patch = api.parentPatch;
    }
    if (!metadata[providerName].apis[serviceName])
      metadata[providerName].apis[serviceName] = {};
    if (api.patch && Object.keys(api.patch).length > 0) {
      metadata[providerName].apis[serviceName].patch = api.patch;
    }
    if (!metadata[providerName].apis[serviceName][version])
      metadata[providerName].apis[serviceName][version] = {};

    metadata[providerName].apis[serviceName][version] = Object.assign(
      {},
      metadata[providerName].apis[serviceName][version],
      entry,
    );
    if (metadata[providerName].apis[serviceName][version].added === undefined) {
      metadata[providerName].apis[serviceName][version].added = now;
    }
    delete metadata[providerName].apis[serviceName][version].patch; // temp FIXME (removing patches at version level)
    delete metadata[providerName].data; // cleanse previous stored data
  }
  return metadata;
}

async function runDrivers(argv) {
  if (argv.skipDrivers) return {};
  for (let driver of drivers.keys()) {
    const providers = drivers.get(driver);
    for (let provider of providers.keys()) {
      if (!argv.driver || driver === argv.driver) {
        logger.log('Running driver', driver, 'for', provider);
        await driverFuncs[driver](provider, providers.get(provider));
      }
    }
  }
  return drivers;
}

function getCandidates(command, pathspec, argv) {
  const returnAll =
    argv.driver === 'none' ||
    (pathspec === defaultPathSpec && command !== 'update');
  const driver = returnAll ? undefined : argv.driver;
  const result = [];

  for (let provider in metadata) {
    for (let service in metadata[provider].apis) {
      for (let version in metadata[provider].apis[service]) {
        if (
          version !== 'patch' &&
          (returnAll ||
            (driver && driver === metadata[provider].driver) ||
            (!driver && metadata[provider].apis[service][version].run === now))
        ) {
          const entry = {
            provider,
            driver: metadata[provider].driver,
            service,
            version,
            parent: metadata[provider].apis[service],
            gp: metadata[provider],
            md: metadata[provider].apis[service][version],
          };
          if (apis[entry.md.filename])
            entry.info = apis[entry.md.filename].info;
          result.push(entry);
          let driverProviders = drivers.get(metadata[provider].driver);
          if (driverProviders) {
            driverProviders.set(provider, metadata[provider]);
          } else {
            const providers = new Map();
            providers.set(provider, metadata[provider]);
            drivers.set(metadata[provider].driver, providers);
          }
        }
      }
    }
  }

  return result;
}

function trimLeads(candidates) {
  // if a lead already exists in candidates by url, remove it from leads, but copy
  // up any file or preferred property

  if (Object.keys(leads).length > 0) {
    for (let candidate of candidates) {
      if (leads[candidate.md.source.url]) {
        if (leads[candidate.md.source.url].file) {
          candidate.md.cached = path.relative(
            '.',
            leads[candidate.md.source.url].file,
          );
        }
        if (typeof leads[candidate.md.source.url].preferred == 'boolean') {
          candidate.md.preferred = leads[candidate.md.source.url].preferred;
        }
        delete leads[candidate.md.source.url];
      }
    }
  }
  const leadsLen = Object.keys(leads).length;
  if (leadsLen) {
    logger.log(leadsLen, 'new leads');
  }
  return leads;
}

module.exports = {
  yamlParse,
  yamlStringify,
  Tree,
  colour,
  defaultPathSpec,
  logger,
  sortJson,
  clone,
  cleanseVersion,
  exec,
  sha256,
  fail,
  now,
  weekAgo,
  loadMetadata,
  saveMetadata,
  gather,
  populateMetadata,
  runDrivers,
  getCandidates,
  trimLeads,
};
