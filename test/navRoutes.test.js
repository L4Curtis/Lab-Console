/**
 * The addresses of the previous navigation keep working (docs/v2/UX.md §4.2):
 * public/js/core/routes.js is pure, so it runs here as the browser runs it
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeRedirect, hashParts } from '../public/js/core/routes.js';

const phone = { isAdmin: true, compact: true };
const wide = { isAdmin: true, compact: false };
const student = { isAdmin: false, compact: false };

test('#/overview leads to the lab on the home page, with its filter', () => {
  for (const who of [phone, wide, student]) {
    assert.equal(routeRedirect('#/overview', who), '#/home/lab');
    assert.equal(routeRedirect('#/overview/', who), '#/home/lab');
  }
  for (const filter of ['all', 'free', 'mine', 'taken', 'locked']) assert.equal(routeRedirect(`#/overview/${filter}`, wide), `#/home/lab/${filter}`);
  assert.equal(routeRedirect('#/overview/nonsense', wide), '#/home/lab', 'an unknown filter is dropped, the lab is still shown');
});

test('#/team opens My team; a tab in the address is kept', () => {
  assert.equal(routeRedirect('#/team', student), '#/team/mine');
  assert.equal(routeRedirect('#/team', phone), '#/team/mine');
  assert.equal(routeRedirect('#/team/calendar/B4M', student), null);
  assert.equal(routeRedirect('#/team/mine', student), null);
});

test('#/admin: the hub list on a phone, the first screen (users) from 720 px', () => {
  assert.equal(routeRedirect('#/admin', phone), null);
  assert.equal(routeRedirect('#/admin', wide), '#/admin/users');
  assert.equal(routeRedirect('#/admin/audit', wide), null);
  assert.equal(routeRedirect('#/admin/audit', phone), null);
});

test('addresses that did not change are left alone', () => {
  for (const hash of ['#/status', '#/status/health', '#/infra', '#/jobs', '#/jobs/B4M/backup', '#/consoles', '#/consoles/B4M/R1', '#/home', '#/help/journal', '#/account', '', '#', '#/']) {
    assert.equal(routeRedirect(hash, wide), null, hash);
    assert.equal(routeRedirect(hash, phone), null, hash);
  }
});

test('the marker of an open sheet is not part of the screen', () => {
  assert.deepEqual(hashParts('#/team/mine?sheet'), ['team', 'mine']);
  assert.deepEqual(hashParts('#/'), []);
  assert.equal(routeRedirect('#/team?sheet', student), '#/team/mine');
});
