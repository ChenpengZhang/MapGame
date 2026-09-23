'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
const root=path.join(__dirname,'..');
const children=[];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');process.exitCode=code;}
const backend=spawn(process.execPath,['--env-file=.env','src/main.js'],{cwd:path.join(root,'backend'),stdio:'inherit'});
children.push(backend);
const frontend=spawn(process.execPath,['server.js'],{cwd:root,stdio:'inherit',env:{...process.env,NO_OPEN:'1'}});
children.push(frontend);
for(const child of children){child.on('error',()=>stop(1));child.on('exit',code=>{if(!stopping)stop(code||0);});}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop());
console.log('游戏与账户入口：http://localhost:8080/mapgame/');
