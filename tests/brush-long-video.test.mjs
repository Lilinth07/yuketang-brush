import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('brush covers a long video across heartbeat requests without resetting the sequence', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'yuketang-long-video-'));
  try {
    const out = path.join(data, 'out');
    fs.mkdirSync(out);
    const course = {
      origin: 'https://fixture.invalid', classroomId: 1, courseId: 2, skuId: 3,
      lmsUserId: 4, sign: 'fixture', name: '测试课程',
    };
    fs.writeFileSync(path.join(data, 'config.local.json'), JSON.stringify({ courses: [course] }));
    fs.writeFileSync(path.join(out, 'cookies.json'), '[]');
    fs.writeFileSync(path.join(out, 'leaves-1.json'), JSON.stringify([
      { leaf_id: 5, leaf_type: 0, name: '第2单元复习' },
    ]));

    const mock = path.join(data, 'mock.mjs');
    fs.writeFileSync(mock, `
      import assert from 'node:assert/strict';
      const duration = 2758;
      let seconds = 2424;
      let previous;
      const sizes = [];

      globalThis.fetch = async (url, options) => {
        const { origin, pathname } = new URL(url);
        assert.equal(origin, 'https://fixture.invalid');
        switch (pathname) {
          case '/api/v3/user/basic-info':
            return Response.json({ code: 0, data: { id: 4, name: '测试账号' } });
          case '/video-log/get_video_watch_progress/':
            return Response.json({ data: { 5: {
              completed: Number(seconds >= duration),
              rate: Math.min(seconds / duration, 1), watch_length: seconds, video_length: duration,
            } } });
          case '/video-log/heartbeat/': {
            assert.equal(options.method, 'POST');
            const events = JSON.parse(options.body).heart_data;
            sizes.push(events.length);
            assert.ok(events.length <= 400);
            for (const event of events) {
              assert.equal(Object.hasOwn(event, 'cc'), false);
              if (previous) {
                assert.equal(event.sq, previous.sq + 1);
                assert.equal(Number(event.ts) - Number(previous.ts), 5000);
                assert.ok(event.cp >= previous.cp);
              }
              previous = event;
            }
            if (previous.cp === duration - 0.5) {
              assert.deepEqual(sizes, [400, 164]);
              seconds = duration;
            }
            return Response.json({});
          }
          default:
            assert.fail('Unexpected mock request');
        }
      };
    `);

    const script = fileURLToPath(new URL('../src/brush.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [
      '--import', mock, script, '--course', '1', '--no-verify', '--sleep', '0',
    ], { env: { ...process.env, YUKETANG_DATA_DIR: data }, encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
    assert.match(run.stdout, /✓ 完成.*第2单元复习/);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});
