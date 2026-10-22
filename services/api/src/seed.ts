import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'node:path';
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
async function seed() {
  await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/techloop');
  const users = mongoose.connection.collection('users');
  const listings = mongoose.connection.collection('listings');
  const existing = await users.countDocuments();
  if (existing === 0) {
    const passwordHash = await bcrypt.hash('demo-password', 12);
    const staff = new mongoose.Types.ObjectId();
    const partner = new mongoose.Types.ObjectId();
    await users.insertMany([
      { _id: staff, email: 'ops@techloop.local', passwordHash, name: 'Aarav Kapoor', role: 'staff', permissions: ['*'], active: true, createdAt: new Date(), updatedAt: new Date() },
      { _id: partner, email: 'partner@techloop.local', passwordHash, name: 'Rohan Singh', role: 'delivery', permissions: ['pickup:read', 'pickup:update'], active: true, createdAt: new Date(), updatedAt: new Date() }
    ]);
    const listing = new mongoose.Types.ObjectId();
    await listings.insertOne({
      _id: listing, reference: 'TL-2026-00142', customerReference: 'CUS-1048',
      device: { category: 'Laptop', model: 'Dell Inspiron 15', quantity: 1, condition: 'Minor Scratches', accessories: ['Charger'] },
      detection: { status: 'confirmed', label: 'laptop', confidence: 0.94, modelVersion: 'yolo-onnx-v1' },
      indicativeOfferMinor: 185000, provisionalPoints: 320, status: 'Under Review', pickupStatus: 'Unassigned', paymentStatus: 'Not Initiated',
      address: { line1: '14 Palm Grove Road', city: 'Bengaluru', postalCode: '560001', phone: '+91 90000 00000' },
      statusHistory: [{ status: 'Submitted', actor: 'customer', createdAt: new Date(Date.now() - 86400000) }, { status: 'Under Review', actor: 'system', createdAt: new Date() }],
      createdAt: new Date(), updatedAt: new Date()
    });
    await mongoose.connection.collection('wallets').insertOne({
      user: staff,
      balance: 320,
      transactions: [{ reference: 'PTS-TL-2026-00142', type: 'Credit', points: 320, reason: 'Eligible device listing', status: 'Credited', createdAt: new Date() }],
      createdAt: new Date(), updatedAt: new Date()
    });
    console.log('Seeded demo accounts and listing.');
  } else {
    console.log('Demo records already exist; leaving existing operational data unchanged.');
  }
  const staffUser = await users.findOne({ email: 'ops@techloop.local' });
  if (staffUser) {
    await mongoose.connection.collection('wallets').updateOne(
      { user: staffUser._id },
      { $setOnInsert: { user: staffUser._id, balance: 320, transactions: [{ reference: 'PTS-TL-2026-00142', type: 'Credit', points: 320, reason: 'Eligible device listing', status: 'Credited', createdAt: new Date() }], createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true }
    );
  }
  await mongoose.disconnect();
}
seed().catch((error) => { console.error(error); process.exitCode = 1; });
