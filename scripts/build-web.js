'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { copyPublicAssets } = require('./assets');
const destination = path.join(__dirname,'..','dist','mapgame');
// This directory is generated exclusively by this script. Rebuild without stale assets.
fs.rmSync(destination,{recursive:true,force:true});
copyPublicAssets(path.join(__dirname,'..'),destination);
console.log('Static site built: dist/mapgame/ (deploy at /mapgame/)');
