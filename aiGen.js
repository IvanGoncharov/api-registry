const util = require('util');
const ng = require('./backend.js');

async function main(prompt) {
  const resp = await ng.ai(prompt);
  console.log(resp);
}

let args = Array(process.argv[2]);
args.splice(0,2);
main(args.join(' '));
