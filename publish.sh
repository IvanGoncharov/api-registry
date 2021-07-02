#!/bin/sh
npm version patch && npm publish && git push && git push --tags
