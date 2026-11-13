import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { parseDrawio, labelLines, DrawioRefusal } from '../src/modules/consoles/drawio.js';

const page = (cells) => `<mxfile><diagram id="p1" name="LAB"><mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`;

test('label convention ".211 - 2001" resolves against the network prefix', () => {
  const { labs } = parseDrawio(page(`<mxCell id="r1" value="R1&lt;div&gt;.211 - 2001&lt;/div&gt;" style="shape=mxgraph.cisco19.rect;prIcon=router;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="40" height="40" as="geometry"/></mxCell>`), { networkPrefix: '10.22.9' });
  const d = labs[0].devices[0];
  assert.equal(d.name, 'R1');
  assert.equal(d.kind, 'router');
  assert.deepEqual(d.target, { host: '10.22.9.211', port: 2001, source: 'label' });
  assert.equal(d.key, 'p1:r1');
});

test('explicit Edit Data attributes win over the label', () => {
  const { labs } = parseDrawio(page(`<UserObject id="s1" label="Core switch" console_host="10.1.1.5" console_port="2042"><mxCell style="shape=mxgraph.cisco19.rect;prIcon=l2_switch;" vertex="1" parent="1"><mxGeometry width="40" height="40" as="geometry"/></mxCell></UserObject>`));
  assert.deepEqual(labs[0].devices[0].target, { host: '10.1.1.5', port: 2042, source: 'data' });
  assert.equal(labs[0].devices[0].kind, 'switch');
});

test('edges use exit/entry constraints and place relative labels', () => {
  const { labs } = parseDrawio(page(`
    <mxCell id="a" value="A .1 - 2001" vertex="1" parent="1"><mxGeometry x="0" y="0" width="40" height="40" as="geometry"/></mxCell>
    <mxCell id="b" value="B .1 - 2002" vertex="1" parent="1"><mxGeometry x="200" y="0" width="40" height="40" as="geometry"/></mxCell>
    <mxCell id="e" style="edgeStyle=none;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="l" value="g0/0" style="edgeLabel;" vertex="1" connectable="0" parent="e"><mxGeometry x="-1" y="10" relative="1" as="geometry"/></mxCell>`));
  const e = labs[0].edges[0];
  assert.deepEqual(e.points, [{ x: 40, y: 20 }, { x: 200, y: 20 }]);
  assert.deepEqual(e.labels[0], { text: 'g0/0', x: 40, y: 10 }); // perpendicular offset like mxGraph
});

test('compressed pages are decoded', () => {
  const model = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="x" value="S9 .212 - 2030" vertex="1" parent="1"><mxGeometry width="40" height="40" as="geometry"/></mxCell></root></mxGraphModel>';
  const packed = zlib.deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
  const { labs } = parseDrawio(`<mxfile><diagram id="z" name="Z">${packed}</diagram></mxfile>`);
  assert.equal(labs[0].devices[0].target.port, 2030);
});

test('the shipped lab diagram: 8 labs, 71 devices, typo on B5H detected', () => {
  const { labs, warnings } = parseDrawio(fs.readFileSync('diagrams/diagram.drawio', 'utf8'));
  assert.equal(labs.length, 8);
  assert.equal(labs.reduce((n, l) => n + l.devices.length, 0), 71);
  assert.ok(warnings.some((w) => w.code === 'consoles.warn_different_devices' && w.message.includes('10.22.9.212:2005') && w.params.target === '10.22.9.212:2005'));
});

test('labelLines strips HTML and entities', () => {
  assert.deepEqual(labelLines('R1<div>.211&nbsp;-&nbsp;2001</div><br>'), ['R1', '.211 - 2001']);
});

// ─── Refusals that no way of writing a page may get around ──────────────────

const MODEL = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="x" value="S9 .212 - 2030" vertex="1" parent="1"><mxGeometry width="40" height="40" as="geometry"/></mxCell></root></mxGraphModel>';
const DOCTYPE_MODEL = `<!DOCTYPE m [<!ENTITY a "boom"><!ENTITY b "&a;&a;&a;">]>${MODEL}`;
const pack = (xml) => zlib.deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString('base64');
const wrap = (body) => `<mxfile><diagram id="z" name="Z">${body}</diagram></mxfile>`;
const refusal = (fn) => assert.throws(fn, (err) => err instanceof DrawioRefusal && err.code === 'doctype');

test('a DOCTYPE or entities in a compressed page are refused, however the page is written', () => {
  const packed = pack(DOCTYPE_MODEL);
  refusal(() => parseDrawio(wrap(packed)));
  // The same bytes, written so that a pattern looking for `<diagram>base64</diagram>` does not see them
  refusal(() => parseDrawio(wrap(`<![CDATA[${packed}]]>`)));
  refusal(() => parseDrawio(wrap(`${packed.slice(0, 20)}<!-- split -->${packed.slice(20)}`)));
  refusal(() => parseDrawio(wrap(`&#${packed.charCodeAt(0)};${packed.slice(1)}`)));
  // And an honest page written the same ways still opens
  const honest = pack(MODEL);
  for (const body of [`<![CDATA[${honest}]]>`, `${honest.slice(0, 20)}<!-- split -->${honest.slice(20)}`, `&#${honest.charCodeAt(0)};${honest.slice(1)}`]) {
    assert.equal(parseDrawio(wrap(body)).labs[0].devices[0].target.port, 2030);
  }
});

test('a DOCTYPE in the file itself is refused, and so is a stray entity declaration', () => {
  refusal(() => parseDrawio(`<?xml version="1.0"?><!DOCTYPE mxfile [<!ENTITY x "boom">]>${wrap(MODEL)}`));
  refusal(() => parseDrawio(wrap(MODEL).replace('<mxfile>', '<mxfile><!ENTITY y SYSTEM "file:///etc/passwd">')));
});

test('pages that inflate to more than the budget are refused, one by one and all together, without being inflated', () => {
  const bomb = (bytes) => pack(`<mxGraphModel><root><mxCell id="0" value="${'a'.repeat(bytes)}"/></root></mxGraphModel>`);
  const small = 64 * 1024;
  assert.ok(bomb(2 * 1024 * 1024).length < 8 * 1024, 'a bomb is small on the wire');
  assert.throws(() => parseDrawio(wrap(bomb(2 * 1024 * 1024)), { maxInflatedBytes: small }), (err) => err instanceof DrawioRefusal && err.code === 'too_large');
  // Each page is under the budget, together they are not
  const two = `<mxfile><diagram id="a" name="A">${bomb(40 * 1024)}</diagram><diagram id="b" name="B">${bomb(40 * 1024)}</diagram></mxfile>`;
  assert.throws(() => parseDrawio(two, { maxInflatedBytes: small }), (err) => err instanceof DrawioRefusal && err.code === 'too_large');
  // The honest page is far below any budget
  assert.equal(parseDrawio(wrap(pack(MODEL)), { maxInflatedBytes: small }).labs.length, 1);
  // A page that is not a deflate stream is still the ordinary "could not be decoded"
  assert.throws(() => parseDrawio(wrap('bm90IGRlZmxhdGU=')), /could not be decoded/);
});
