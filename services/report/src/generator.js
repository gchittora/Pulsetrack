// ------------------------------------------------------------------
// Report Generator
//
// Generates two types of reports from MongoDB event data:
//
// 1. CSV — Flat file of raw events, ideal for:
//    - Importing into Excel/Sheets for ad-hoc analysis
//    - Feeding into data pipelines (Spark, Pandas)
//    - Compliance/audit exports
//
// 2. PDF — Formatted summary report, ideal for:
//    - Stakeholder presentations
//    - Weekly/monthly analytics snapshots
//    - Archival records
//
// WHY generate on-demand instead of pre-computing?
//   Reports are expensive (scan full collections, format output).
//   Pre-computing wastes resources if nobody downloads them.
//   On-demand generation via a job queue means:
//   - Reports are always fresh
//   - No wasted compute
//   - Users can customize date ranges and filters
// ------------------------------------------------------------------

const { Parser: CsvParser } = require('json2csv');
const PDFDocument = require('pdfkit');
const { getDb } = require('./db');

async function generateCSV(projectId, startDate, endDate) {
  const db = getDb();

  const query = { project_id: parseInt(projectId) };
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate).getTime();
    if (endDate) query.timestamp.$lte = new Date(endDate).getTime();
  }

  const events = await db.collection('events')
    .find(query)
    .sort({ timestamp: -1 })
    .limit(10000) // Safety cap
    .toArray();

  if (events.length === 0) {
    return Buffer.from('No events found for the specified criteria.\n');
  }

  const fields = ['event', 'user_id', 'project_id', 'timestamp', 'properties'];
  const parser = new CsvParser({
    fields,
    transforms: [
      (item) => ({
        ...item,
        timestamp: new Date(item.timestamp).toISOString(),
        properties: JSON.stringify(item.properties || {}),
      })
    ]
  });

  const csv = parser.parse(events);
  return Buffer.from(csv);
}

async function generatePDF(projectId, startDate, endDate) {
  const db = getDb();

  const query = { project_id: parseInt(projectId) };
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate).getTime();
    if (endDate) query.timestamp.$lte = new Date(endDate).getTime();
  }

  // Aggregation pipeline for summary stats
  const [stats] = await db.collection('events').aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        uniqueUsers: { $addToSet: '$user_id' },
        events: { $addToSet: '$event' },
        earliest: { $min: '$timestamp' },
        latest: { $max: '$timestamp' },
      }
    }
  ]).toArray();

  // Per-event breakdown
  const breakdown = await db.collection('events').aggregate([
    { $match: query },
    { $group: { _id: '$event', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Title
    doc.fontSize(24).font('Helvetica-Bold').text('PulseTrack Analytics Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica').fillColor('#666')
      .text(`Project ID: ${projectId}`, { align: 'center' });
    doc.text(`Generated: ${new Date().toISOString()}`, { align: 'center' });

    if (startDate || endDate) {
      doc.text(`Period: ${startDate || 'beginning'} to ${endDate || 'now'}`, { align: 'center' });
    }

    doc.moveDown(2);

    // Summary
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#000').text('Summary');
    doc.moveDown(0.5);

    if (stats) {
      doc.fontSize(12).font('Helvetica');
      doc.text(`Total Events: ${stats.total.toLocaleString()}`);
      doc.text(`Unique Users: ${stats.uniqueUsers.length}`);
      doc.text(`Event Types: ${stats.events.length}`);
      doc.text(`Date Range: ${new Date(stats.earliest).toISOString().split('T')[0]} to ${new Date(stats.latest).toISOString().split('T')[0]}`);
    } else {
      doc.fontSize(12).font('Helvetica').text('No events found.');
    }

    doc.moveDown(2);

    // Breakdown table
    if (breakdown.length > 0) {
      doc.fontSize(16).font('Helvetica-Bold').text('Event Breakdown');
      doc.moveDown(0.5);

      // Table header
      doc.fontSize(11).font('Helvetica-Bold');
      doc.text('Event Type', 50, doc.y, { width: 200, continued: true });
      doc.text('Count', { width: 100, align: 'right' });
      doc.moveDown(0.3);

      // Divider
      doc.moveTo(50, doc.y).lineTo(350, doc.y).stroke('#ccc');
      doc.moveDown(0.3);

      // Rows
      doc.font('Helvetica').fontSize(11);
      for (const row of breakdown) {
        doc.text(row._id, 50, doc.y, { width: 200, continued: true });
        doc.text(row.count.toLocaleString(), { width: 100, align: 'right' });
        doc.moveDown(0.2);
      }
    }

    // Footer
    doc.moveDown(3);
    doc.fontSize(9).fillColor('#999')
      .text('Generated by PulseTrack Report Service', { align: 'center' });

    doc.end();
  });
}

module.exports = { generateCSV, generatePDF };
