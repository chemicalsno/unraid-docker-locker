// Runs lock.js from the .plg against the stock Unraid 7.3 docker.js on a minimal
// copy of the Docker Containers page. Set DOCKER_JS to the path of another
// docker.js to check the plugin against a newer Unraid release.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';

const require = createRequire(import.meta.url);
const plg = readFileSync(new URL('../docker.locker.plg', import.meta.url), 'utf8');
const lockJS = plg.match(/javascript\/lock\.js">\s*<INLINE><!\[CDATA\[([\s\S]*?)\]\]><\/INLINE>/)[1];
const dockerJS = readFileSync(process.env.DOCKER_JS || new URL('./fixtures/docker.js', import.meta.url), 'utf8');
const jquery = readFileSync(require.resolve('jquery/dist/jquery.js'), 'utf8');

const LIST_URL = '/plugins/dynamix.docker.manager/include/DockerContainers.php';
const LOCK_URL = '/plugins/docker.locker/include/Lock.php';

// update: 0 up to date, 1 update ready (same codes DockerContainers.php emits)
const CONTAINERS = [
  {name: 'web', id: 'aaa111', update: 1},
  {name: 'dev-db', id: 'bbb222', update: 1},
  {name: 'app', id: 'ccc333', update: 1},
  {name: 'cache', id: 'ddd444', update: 0},
];

// dashboard: true gives a page that loads docker.js but has no container list or Update All.
// redesigned: true gives a Docker page that no longer uses docker.js or the stock markup.
// running: false means the Docker service is stopped.
async function page({locked = [], containers = CONTAINERS, stockUpdateAll, loadBeforeReady = false,
  dashboard = false, redesigned = false, running = true} = {}) {
  const stockPage = !dashboard && !redesigned;
  const dom = new JSDOM(`<!doctype html><body>${stockPage ? `
    <table><tbody id="docker_list"></tbody></table>
    <input type="button" onclick="updateAll()" value="Update All" id="updateAll">` : ''}
  </body>`, {runScripts: 'dangerously', url: `http://tower.local/${dashboard ? 'Dashboard' : 'Docker'}`});
  const w = dom.window;
  w.eval(jquery);
  const calls = {openDocker: [], swal: [], posts: [], banners: []};
  let saved = locked.slice();
  let lockReadFails = false;
  w._ = (s) => s;
  w.openDocker = (...args) => calls.openDocker.push(args);
  w.swal = (opts, cb) => calls.swal.push({opts, cb});
  w.addBannerWarning = (text, warning, noDismiss) => calls.banners.push({text, warning, noDismiss});
  w.dockerLockerRunning = running;
  w.$.ajaxTransport('+*', (options) => ({
    send(headers, done) {
      if (options.url.startsWith(LIST_URL)) return done(200, 'success', {text: listBody(containers)});
      if (options.url.startsWith(LOCK_URL) && options.type === 'GET') {
        if (lockReadFails) return done(500, 'error');
        return done(200, 'success', {text: JSON.stringify(saved)});
      }
      if (options.url === LOCK_URL) {
        const data = new w.URLSearchParams(options.data);
        calls.posts.push(Object.fromEntries(data));
        saved = saved.filter((n) => n !== data.get('name'));
        if (data.get('locked') === '1') saved.push(data.get('name'));
        return done(200, 'success', {text: JSON.stringify(saved.sort())});
      }
      done(404, 'error');
    },
    abort() {},
  }));
  w.eval('var loadlistCalls = 0;');
  if (!redesigned) {
    w.eval('var docker = [];');
    w.eval(dockerJS);
  }
  if (stockUpdateAll) w.eval(stockUpdateAll);
  w.dockerLocker = locked;
  w.eval(lockJS);
  // mirrors the stock loadlist(): render rows, run the docker.push() script, enable buttons
  if (stockPage) w.eval(`function loadlist() {
    loadlistCalls++;
    docker = [];
    $.get('${LIST_URL}', function(d) {
      var data = d.split(/\\0/);
      $('#docker_list').html(data[0]);
      (new Function(data[1]))();
      $('input[type=button]').prop('disabled',false);
      var update = false;
      for (var i=0,ct; ct=docker[i]; i++) if (ct.update==1) update = true;
      if (!update) $('input#updateAll').prop('disabled',true);
    });
  }`);
  if (loadBeforeReady) w.loadlist();
  await tick(w);
  if (!loadBeforeReady && stockPage) await load(w);
  return {
    w, $: w.$, calls,
    // simulates a change made from another browser tab
    setSaved: (list) => { saved = list.slice(); },
    failLockReads: () => { lockReadFails = true; },
  };
}

function listBody(containers) {
  const rows = containers.map((c) => `<tr class='sortable'><td class='ct-name'><span id='${c.id}' class='hand'></span>${c.name}</td>` +
    `<td class='updatecolumn'>${c.update == 1 ? "<a class='exec'>apply update</a>" : 'up-to-date'}</td></tr>`).join('');
  const pushes = containers.map((c) => `docker.push({name:'${c.name}',id:'${c.id}',state:1,pause:0,update:${c.update}});`).join('');
  return `${rows}\0${pushes}\x000`;
}

// jQuery 3 runs ready handlers and ajax callbacks on later timer turns
async function tick(w) {
  for (let i = 0; i < 5; i++) await new Promise((r) => w.setTimeout(r, 0));
}
async function load(w) {
  w.loadlist();
  await tick(w);
}

test('Update All skips locked containers', async () => {
  const {w, $, calls} = await page({locked: ['dev-db']});
  $('#updateAll').trigger('click');
  await tick(w);
  assert.equal(calls.openDocker.length, 1);
  assert.equal(calls.openDocker[0][0], 'update_container web*app');
  assert.equal(calls.openDocker[0][1], 'Updating all Containers (1 locked)');
});

test('Update All button shows the locked count', async () => {
  const {$} = await page({locked: ['dev-db']});
  assert.equal($('#updateAll').val(), 'Update All (1 locked)');
  assert.equal($('#updateAll').prop('disabled'), false);
});

test('Update All is unchanged with nothing locked', async () => {
  const {w, $, calls} = await page();
  assert.equal($('#updateAll').val(), 'Update All');
  $('#updateAll').trigger('click');
  await tick(w);
  assert.equal(calls.openDocker[0][0], 'update_container web*dev-db*app');
  assert.equal(calls.openDocker[0][1], 'Updating all Containers');
});

test('Update All is disabled when every pending update is locked', async () => {
  const {$} = await page({locked: ['web', 'dev-db', 'app']});
  assert.equal($('#updateAll').prop('disabled'), true);
});

test('rows show a lock toggle that reflects the saved state', async () => {
  const {$} = await page({locked: ['dev-db']});
  assert.equal($('.locker').length, CONTAINERS.length);
  assert.equal($('#bbb222').closest('tr').find('.locker-toggle span').text(), 'locked');
  assert.ok($('#bbb222').closest('tr').find('.locker-toggle i').hasClass('fa-lock'));
  assert.ok($('#bbb222').closest('tr').find('.locker-toggle span').hasClass('orange-text'));
  assert.equal($('#aaa111').closest('tr').find('.locker-toggle span').text(), 'lock');
  assert.ok($('#aaa111').closest('tr').find('.locker-toggle span').hasClass('grey-text'));
});

test('reloading the list does not duplicate toggles', async () => {
  const {w, $} = await page({locked: ['dev-db']});
  await load(w);
  await load(w);
  assert.equal($('.locker').length, CONTAINERS.length);
});

test('a list rendered before the ready handler still gets locks applied', async () => {
  const {w, $, calls} = await page({locked: ['dev-db'], loadBeforeReady: true});
  assert.equal($('.locker').length, CONTAINERS.length);
  assert.equal($('#updateAll').val(), 'Update All (1 locked)');
  assert.equal($('#updateAll').prop('disabled'), false);
  $('#updateAll').trigger('click');
  await tick(w);
  assert.equal(calls.openDocker[0][0], 'update_container web*app');
});

test('clicking the toggle saves the lock and updates the page', async () => {
  const {w, $, calls} = await page();
  $('#aaa111').closest('tr').find('.locker-toggle').trigger('click');
  await tick(w);
  assert.deepEqual(calls.posts, [{name: 'web', locked: '1'}]);
  assert.equal($('#aaa111').closest('tr').find('.locker-toggle span').text(), 'locked');
  assert.equal($('#updateAll').val(), 'Update All (1 locked)');

  $('#aaa111').closest('tr').find('.locker-toggle').trigger('click');
  await tick(w);
  assert.deepEqual(calls.posts[1], {name: 'web', locked: '0'});
  assert.equal($('#updateAll').val(), 'Update All');
});

test('unlocking re-enables Update All', async () => {
  const {w, $} = await page({locked: ['web', 'dev-db', 'app']});
  assert.equal($('#updateAll').prop('disabled'), true);
  $('#aaa111').closest('tr').find('.locker-toggle').trigger('click');
  await tick(w);
  assert.equal($('#updateAll').prop('disabled'), false);
});

test('updating an unlocked container goes through the stock confirmation', async () => {
  const {w, calls} = await page({locked: ['dev-db']});
  w.updateContainer('web');
  await tick(w);
  assert.equal(calls.swal[0].opts.title, 'Are you sure?');
  calls.swal[0].cb();
  assert.equal(calls.openDocker[0][0], 'update_container web');
});

test('updating a locked container warns first', async () => {
  const {w, calls} = await page({locked: ['dev-db']});
  w.updateContainer('dev-db');
  await tick(w);
  assert.equal(calls.swal[0].opts.title, 'Container is locked');
  assert.equal(calls.openDocker.length, 0);
  calls.swal[0].cb();
  assert.equal(calls.openDocker[0][0], 'update_container dev-db');
});

test('Update All re-reads locks changed in another tab', async () => {
  const {w, $, calls, setSaved} = await page();
  setSaved(['web']);
  $('#updateAll').trigger('click');
  await tick(w);
  assert.equal(calls.openDocker[0][0], 'update_container dev-db*app');
  assert.equal(calls.openDocker[0][1], 'Updating all Containers (1 locked)');
});

test('single update re-reads locks changed in another tab', async () => {
  const {w, calls, setSaved} = await page();
  setSaved(['web']);
  w.updateContainer('web');
  await tick(w);
  assert.equal(calls.swal[0].opts.title, 'Container is locked');
});

test('Update All does nothing if every pending update was locked in another tab', async () => {
  const {w, $, calls, setSaved} = await page();
  setSaved(['web', 'dev-db', 'app']);
  const reloads = w.loadlistCalls;
  $('#updateAll').trigger('click');
  await tick(w);
  assert.equal(calls.openDocker.length, 0);
  assert.equal(w.loadlistCalls, reloads + 1);
  assert.equal($('#updateAll').prop('disabled'), true);
});

test('nothing is updated when the lock list cannot be read', async () => {
  const {w, $, calls, failLockReads} = await page();
  failLockReads();
  const reloads = w.loadlistCalls;
  $('#updateAll').trigger('click');
  w.updateContainer('web');
  await tick(w);
  assert.equal(calls.openDocker.length, 0);
  assert.deepEqual(calls.swal.map((s) => s.opts.title), ['Error', 'Error']);
  // the reload puts the buttons back
  assert.equal(w.loadlistCalls, reloads + 1);
  assert.equal($('#updateAll').prop('disabled'), false);
});

test('Dashboard: updating a locked container warns first', async () => {
  const {w, calls} = await page({locked: ['dev-db'], dashboard: true});
  w.updateContainer('dev-db');
  await tick(w);
  assert.equal(calls.swal[0].opts.title, 'Container is locked');
  assert.equal(calls.openDocker.length, 0);
});

test('Dashboard: unlocked containers use the stock confirmation', async () => {
  const {w, calls} = await page({locked: ['dev-db'], dashboard: true});
  w.updateContainer('web');
  await tick(w);
  assert.equal(calls.swal[0].opts.title, 'Are you sure?');
});

test('Dashboard: Update All is not replaced', async () => {
  const {w} = await page({dashboard: true});
  assert.equal(String(w.updateAll).includes('pending()'), false);
});

test('an unrecognised stock updateAll disables Update All while anything is locked', async () => {
  const changed = `function updateAll() { openDocker('something_else', 'x', '', 'loadlist'); }`;
  const {w, $, calls} = await page({locked: ['dev-db'], stockUpdateAll: changed});
  assert.equal($('#updateAll').prop('disabled'), true);
  // the stock function is left alone rather than replaced
  w.updateAll();
  assert.equal(calls.openDocker[0][0], 'something_else');
});

test('an unrecognised stock updateAll is left enabled when nothing is locked', async () => {
  const changed = `function updateAll() { openDocker('something_else', 'x', '', 'loadlist'); }`;
  const {$} = await page({stockUpdateAll: changed});
  assert.equal($('#updateAll').prop('disabled'), false);
});

test('no warning banner on a supported Docker page', async () => {
  const {calls} = await page({locked: ['dev-db']});
  assert.deepEqual(calls.banners, []);
});

test('warning banner when the stock updateAll is unrecognised and something is locked', async () => {
  const changed = `function updateAll() { openDocker('something_else', 'x', '', 'loadlist'); }`;
  const {calls} = await page({locked: ['dev-db'], stockUpdateAll: changed});
  assert.equal(calls.banners.length, 1);
  assert.match(calls.banners[0].text, /does not support this version of Unraid/);
  assert.equal(calls.banners[0].noDismiss, true);
});

test('warning banner on a redesigned Docker page when something is locked', async () => {
  const {calls} = await page({locked: ['dev-db'], redesigned: true});
  assert.equal(calls.banners.length, 1);
});

test('no warning banner on a redesigned Docker page with nothing locked', async () => {
  const {calls} = await page({redesigned: true});
  assert.deepEqual(calls.banners, []);
});

test('no warning banner when the Docker service is stopped', async () => {
  const {calls} = await page({locked: ['dev-db'], redesigned: true, running: false});
  assert.deepEqual(calls.banners, []);
});

test('no warning banner on the Dashboard', async () => {
  const {calls} = await page({locked: ['dev-db'], dashboard: true});
  assert.deepEqual(calls.banners, []);
});

test('locking the first container on an unsupported page shows the banner', async () => {
  const changed = `function updateAll() { openDocker('something_else', 'x', '', 'loadlist'); }`;
  const {w, $, calls} = await page({stockUpdateAll: changed});
  assert.deepEqual(calls.banners, []);
  $('#aaa111').closest('tr').find('.locker-toggle').trigger('click');
  await tick(w);
  assert.equal(calls.banners.length, 1);
});

test('the locked count includes locked containers with no update waiting', async () => {
  const {w, $, calls} = await page({locked: ['dev-db', 'cache']});
  assert.equal($('#updateAll').val(), 'Update All (2 locked)');
  $('#updateAll').trigger('click');
  await tick(w);
  assert.equal(calls.openDocker[0][0], 'update_container web*app');
  assert.equal(calls.openDocker[0][1], 'Updating all Containers (2 locked)');
});

test('locks for containers that no longer exist are not counted', async () => {
  const {$} = await page({locked: ['dev-db', 'deleted-container']});
  assert.equal($('#updateAll').val(), 'Update All (1 locked)');
});

test('the Update All tooltip names the locked containers', async () => {
  const {$} = await page({locked: ['dev-db', 'cache']});
  assert.equal($('#updateAll').attr('title'), 'Skips locked containers: dev-db, cache');
});

test('the Update All tooltip is cleared when nothing is locked', async () => {
  const {w, $} = await page({locked: ['dev-db']});
  $('#bbb222').closest('tr').find('.locker-toggle').trigger('click');
  await tick(w);
  assert.equal($('#updateAll').val(), 'Update All');
  assert.equal($('#updateAll').attr('title'), '');
});
