#!/usr/bin/env python3
"""Docker isolation acceptance test. Uses disposable fake keys; makes no paid API calls."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import shutil
import time
from urllib.request import urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
PROVIDERS = {'openai': 'api.openai.com', 'gemini': 'generativelanguage.googleapis.com', 'mistral': 'api.mistral.ai', 'web': 'api.tavily.com'}
if not shutil.which('docker'):
    raise SystemExit('Docker CLI/Compose and a working daemon are required for runtime isolation checks')
COMPOSE = ['docker', 'compose', '-p', 'tldraw-isolation-' + secrets.token_hex(4), '-f', str(ROOT / 'compose.research.json')]


def run(*args, capture=False):
    return subprocess.run([*COMPOSE, *args], check=True, text=True, capture_output=capture)


def node(service, code):
    run('exec', '-T', service, 'node', '-e', code)


with tempfile.TemporaryDirectory(prefix='tldraw-test-secrets-') as directory:
    os.environ['RESEARCH_SECRETS_DIR'] = directory
    for provider in PROVIDERS:
        for suffix in ['worker-token', 'api-key']:
            path = Path(directory) / (provider + '-' + suffix)
            path.write_text(secrets.token_urlsafe(32))
            path.chmod(0o444)
    try:
        run('config', '--quiet')
        run('build', '--pull')
        for provider in PROVIDERS:
            run('run', '--rm', '--no-deps', 'egress-' + provider, 'squid', '-k', 'parse', '-f', '/etc/squid/squid.conf')
        run('run', '--rm', '--no-deps', 'ingress', 'nginx', '-t')
        run('up', '-d', '--wait', '--wait-timeout', '90')
        for attempt in range(120):
            try:
                urlopen('http://127.0.0.1:5858/api/brainstorm/me', timeout=2)
                raise AssertionError('Unauthenticated ingress accepted')
            except HTTPError as error:
                assert error.code == 401, 'Ingress or API is not healthy'
                break
            except OSError:
                if attempt == 119:
                    raise
                time.sleep(0.25)
        for provider, host in PROVIDERS.items():
            service = 'research-' + provider
            container_id = run('ps', '-q', service, capture=True).stdout.strip()
            config = json.loads(subprocess.check_output(['docker', 'inspect', container_id], text=True))[0]
            assert config['HostConfig']['ReadonlyRootfs']
            assert config['HostConfig']['CapDrop'] == ['ALL']
            assert config['HostConfig']['PidsLimit'] == 64
            assert config['HostConfig']['Memory'] == 256 * 1024 * 1024
            assert config['Config']['User'] == '10001:10001'
            assert not config['HostConfig'].get('PortBindings')
            assert not any('seccomp=unconfined' in opt for opt in config['HostConfig']['SecurityOpt'])
            node(service, f"""
const assert = require('node:assert/strict'), fs = require('node:fs');
assert.equal(process.getuid(), 10001);
assert.deepEqual(fs.readdirSync('/run/secrets').sort(), ['{provider}-api-key','{provider}-worker-token'].sort());
assert.throws(()=>fs.writeFileSync('/app/escape','x'));
assert.throws(()=>fs.readFileSync('/data/metadata/brainstorm.sqlite'));
assert.equal(process.env.OPENAI_API_KEY, undefined);
const token = fs.readFileSync('/run/secrets/{provider}-worker-token','utf8').trim();
(async()=>{{
const res = await fetch('http://127.0.0.1:5860/research', {{method:'POST',headers:{{'content-type':'application/json',authorization:'Bearer '+token}},body:JSON.stringify({{provider:'foreign',prompt:'test',system:'test'}})}});
assert.equal(res.status,403);
const lateral = await fetch('http://api:5858/api/brainstorm/auth/register', {{method:'POST',headers:{{'content-type':'application/json','x-forwarded-for':'172.31.240.2'}},body:JSON.stringify({{username:'bypass',password:'correct-horse-battery'}})}});assert.equal(lateral.status,403);
const noauth = await fetch('http://127.0.0.1:5860/research', {{method:'POST',headers:{{'content-type':'application/json'}},body:'{{}}'}}); assert.equal(noauth.status,401);
}})().catch(()=>process.exit(1));
""")
            node(service, """
const net=require('node:net'), dns=require('node:dns/promises'), assert=require('node:assert/strict');
async function denied(host,port) { await new Promise((resolve,reject)=>{const s=net.connect({host,port});s.setTimeout(1500);s.on('connect',()=>{s.destroy();reject(Error('direct egress allowed'))});s.on('timeout',()=>{s.destroy();resolve()});s.on('error',resolve)}); }
(async()=>{await denied('1.1.1.1',443);await denied('169.254.169.254',80);await assert.rejects(dns.lookup('research-""" + ('gemini' if provider == 'openai' else 'openai') + """'));})().catch(()=>process.exit(1));
""")
            node(service, f"""
const http=require('node:http'),tls=require('node:tls'),assert=require('node:assert/strict');
async function connect(host,allowed) {{await new Promise((resolve,reject)=>{{
const req=http.request({{host:'egress-{provider}',port:3128,method:'CONNECT',path:host+':443'}});req.setTimeout(10000,()=>req.destroy(Error('timeout')));
req.on('connect',(res,socket)=>{{
 if(!allowed) {{socket.destroy();try{{assert.equal(res.statusCode,403);resolve()}}catch(e){{reject(e)}};return;}}
 try{{assert.equal(res.statusCode,200)}}catch(e){{socket.destroy();reject(e);return;}}
 const secure=tls.connect({{socket,servername:host,rejectUnauthorized:true}},()=>{{secure.end();resolve()}});secure.on('error',reject);
}});req.on('error',reject);req.end();}});}}
(async()=>{{for(const host of ['example.com','169.254.169.254','127.0.0.1','{host}.evil.invalid'])await connect(host,false);await connect('{host}',true);}})().catch(()=>process.exit(1));
""")
        run('stop', 'egress-openai')
        node('research-openai', """
const fs=require('node:fs'),assert=require('node:assert/strict');
const token=fs.readFileSync('/run/secrets/openai-worker-token','utf8').trim();
(async()=>{const r=await fetch('http://localhost:5860/research',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({provider:'openai',prompt:'test',system:'test'}),signal:AbortSignal.timeout(115000)});assert.equal(r.status,502);assert.deepEqual(await r.json(),{error:'Provider request failed'});})().catch(()=>process.exit(1));
""")
        print('PASS: filesystem, identity, secrets, resources, direct/lateral egress, proxy allow/deny, and proxy outage')
    finally:
        subprocess.run([*COMPOSE, 'down', '--volumes', '--remove-orphans'], check=False)
