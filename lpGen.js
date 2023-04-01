const util = require('util');
const ng = require('./backend.js');

async function main(site) {
  const resp = await ng.ai(`Write 150 to 250 words on what ${site} does`);
  console.log(resp);
}

const site = process.argv[2];
main(site);
