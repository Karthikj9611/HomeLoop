// One-off: node migrate-faststart.js   (needs MONGODB_URI). Rewrites already-uploaded videos in place (same _id, same
// length, same /videos/<id>.<ext> URL) so moov is at the front. Safe to re-run: already-fast files are skipped.
const mongoose = require('mongoose');
const { faststart } = require('./faststart');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'videos' });
  const files = await bucket.find({}).toArray();
  let fixed = 0, skipped = 0, failed = 0;
  for (const f of files) {
    try {
      const chunks = [];
      for await (const c of bucket.openDownloadStream(f._id)) chunks.push(c);
      const orig = Buffer.concat(chunks);
      const out = faststart(orig);
      if (out === orig) { skipped++; continue; }
      await bucket.delete(f._id);
      try {
        await new Promise((res, rej) => {
          const s = bucket.openUploadStreamWithId(f._id, f.filename, { chunkSizeBytes: 1024 * 1024, contentType: f.contentType, metadata: f.metadata });
          s.on('error', rej); s.on('finish', res); s.end(out);
        });
      } catch (e) { // put the original back rather than lose the video
        await new Promise((res, rej) => { const s = bucket.openUploadStreamWithId(f._id, f.filename, { contentType: f.contentType, metadata: f.metadata }); s.on('error', rej); s.on('finish', res); s.end(orig); });
        throw e;
      }
      fixed++; console.log('fixed', String(f._id));
    } catch (e) { failed++; console.error('failed', String(f._id), e.message); }
  }
  console.log({ total: files.length, fixed, skipped, failed });
  process.exit(0);
})();
