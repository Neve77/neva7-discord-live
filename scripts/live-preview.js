// Offline dashboard preview. Does not read .env, log in or call an AI provider.
const {WebPanel}=require('../src/web-panel');
const {previewController}=require('./live-preview-fixture');
const controller=previewController(process.argv.includes('--qa'));
const server=new WebPanel(controller,{port:Number(process.env.LIVE_PREVIEW_PORT||3211)});
server.start().then(url=>console.log('Preview local sem Discord/API: '+url));
process.once('SIGINT',async()=>{await server.stop();process.exit(0);});
