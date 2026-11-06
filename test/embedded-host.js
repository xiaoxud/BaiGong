import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const frame = document.querySelector('iframe');
const bridge = new AppBridge(null, { name: 'BaiGong test host', version: '1.0.0' }, { serverTools: {}, logging: {} });
bridge.oncalltool = async params => {
  const response = await fetch('/host-call', { method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(params) });
  return response.json();
};
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));
frame.src='/embedded';
