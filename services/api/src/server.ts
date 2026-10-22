import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import mongoose, { Schema, model } from 'mongoose';
import morgan from 'morgan';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { z } from 'zod';
import { CatalogItem, CarbonLedger, SellOrder } from './models/sourceOfTruth';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
const app = express();
const port = Number(process.env.PORT ?? 4000);
const jwtSecret = process.env.JWT_SECRET ?? 'development-only-secret';
const mongoUri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/techloop';
const userMongoUri = process.env.USER_MONGO_URI;
const userMongoDb = process.env.USER_MONGO_DB ?? 'innotech_ewaste';
const authorizedAdminEmails = new Set((process.env.AUTHORIZED_ADMIN_EMAILS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean));

const statusValues = ['Submitted', 'Under Review', 'Approved', 'Rejected', 'Awaiting User Decision', 'Accepted', 'Cancelled', 'Completed', 'Disputed'] as const;
const pickupStatusValues = ['Unassigned', 'Assigned', 'Accepted', 'En Route', 'Arrived', 'Collected', 'Failed', 'Reschedule Requested', 'Cancelled', 'Handover Pending', 'Handed Over'] as const;

const User = model('User', new Schema({
  email: { type: String, unique: true, required: true, lowercase: true },
  pendingEmail: { type: String, lowercase: true },
  emailVerified: { type: Boolean, default: true },
  passwordHash: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['staff', 'super_admin', 'delivery', 'customer', 'technician'], required: true },
  permissions: { type: [String], default: [] },
  active: { type: Boolean, default: true },
  profile: { phone: String, specialization: String, contractEndsAt: Date, customerReference: String }
}, { timestamps: true }));

const Listing = model('Listing', new Schema({
  reference: { type: String, unique: true, required: true },
  customerReference: String,
  device: { category: String, model: String, quantity: Number, condition: String, accessories: [String], imageUrl: String },
  detection: { status: String, label: String, confidence: Number, modelVersion: String },
  indicativeOfferMinor: Number,
  provisionalPoints: Number,
  status: { type: String, enum: statusValues, default: 'Submitted' },
  pickupStatus: { type: String, enum: pickupStatusValues, default: 'Unassigned' },
  paymentStatus: { type: String, default: 'Not Initiated' },
  pickup: { type: Boolean, default: false },
  pickedUpAt: { type: Date, default: null },
  verified: { type: Boolean, default: false },
  verifiedAt: { type: Date, default: null },
  verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  inspectionNotes: String,
  paid: { type: Boolean, default: false },
  paidAt: { type: Date, default: null },
  paymentReference: { type: String, default: '' },
  failedPickupReason: String,
  assignedPartner: { type: Schema.Types.ObjectId, ref: 'User' },
  address: { line1: String, city: String, postalCode: String, phone: String },
  statusHistory: [{ status: String, reason: String, actor: String, createdAt: Date }]
}, { timestamps: true }));

const Pickup = model('PickupAssignment', new Schema({
  listing: { type: Schema.Types.ObjectId, ref: 'Listing', required: true },
  partner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  technician: { type: Schema.Types.ObjectId, ref: 'User' },
  window: String,
  priority: { type: String, default: 'Standard' },
  instructions: String,
  status: { type: String, enum: pickupStatusValues, default: 'Assigned' },
  events: [{ status: String, reason: String, actor: String, createdAt: Date }],
  evidence: { checklist: [String], notes: String, photoUrl: String, otpConfirmed: Boolean },
  handover: { receiver: String, quantity: Number, notes: String, confirmedAt: Date }
}, { timestamps: true }));

const Offer = model('Offer', new Schema({
  listing: { type: Schema.Types.ObjectId, ref: 'Listing', required: true },
  amountMinor: Number,
  points: Number,
  reason: String,
  version: Number,
  status: { type: String, default: 'Awaiting User Decision' },
  createdBy: String
}, { timestamps: true }));

const AuditLog = model('AuditLog', new Schema({
  actor: String, action: String, entityType: String, entityId: String, reason: String, metadata: Schema.Types.Mixed
}, { timestamps: true }));
const walletTransactionSchema = new Schema({
  reference: String, type: String, points: Number, reason: String, status: String, createdAt: Date
}, { _id: false });
const Wallet = model('Wallet', new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User' },
  customerReference: { type: String, index: true },
  balance: { type: Number, default: 0 },
  transactions: { type: [walletTransactionSchema], default: [] }
}, { timestamps: true }));
const PasswordReset = model('PasswordReset', new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  usedAt: Date
}, { timestamps: true }));
const Reward = model('Reward', new Schema({
  name: { type: String, required: true },
  type: { type: String, enum: ['basic', 'advanced'], required: true },
  pointsRequired: { type: Number, required: true },
  valueMinor: { type: Number, required: true },
  description: String,
  active: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true }));
const Redemption = model('Redemption', new Schema({
  reward: { type: Schema.Types.ObjectId, ref: 'Reward', required: true },
  customerReference: { type: String, required: true },
  user: { type: Schema.Types.ObjectId, ref: 'User' },
  points: { type: Number, required: true },
  status: { type: String, enum: ['Requested', 'Approved', 'Fulfilled'], default: 'Requested' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true }));

type AuthRequest = Request & { user?: { id: string; email: string; role: string; permissions: string[] } };
const privilegedRoles = new Set(['staff', 'super_admin']);
const isAuthorizedAdmin = (email: string) => authorizedAdminEmails.has(email.toLowerCase());
const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
  try {
    const claims = jwt.verify(token, jwtSecret) as { id: string };
    const user = await User.findById(claims.id).select('email role permissions active');
    if (!user || !user.active || (privilegedRoles.has(user.role) && !isAuthorizedAdmin(user.email))) return res.status(401).json({ error: { code: 'ACCOUNT_NOT_AUTHORIZED', message: 'This account is inactive or not authorized for this panel' } });
    req.user = { id: user.id, email: user.email, role: user.role, permissions: user.permissions };
    return next();
  } catch {
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Session expired or invalid' } });
  }
};
const requireRole = (...roles: string[]) => (req: AuthRequest, res: Response, next: NextFunction) => {
  const allowed = Boolean(req.user && (roles.includes(req.user.role) || (roles.includes('staff') && privilegedRoles.has(req.user.role))));
  if (!req.user || !allowed || (privilegedRoles.has(req.user.role) && !isAuthorizedAdmin(req.user.email))) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
  return next();
};
const writeAudit = (actor: string, action: string, entityType: string, entityId: string, reason?: string) => AuditLog.create({ actor, action, entityType, entityId, reason });
const transition = async (listing: any, status: typeof statusValues[number], actor: string, reason?: string) => {
  listing.statusHistory.push({ status, actor, reason, createdAt: new Date() });
  listing.status = status;
  await listing.save();
};
const syncSellOrder = async (listing: any) => {
  const status = listing.status === 'Cancelled' || listing.status === 'Rejected' ? 'cancelled' : listing.paid ? 'completed_paid' : listing.verified ? 'inspected_verified' : listing.pickup ? 'pickup_scheduled' : listing.pickupStatus !== 'Unassigned' ? 'pickup_scheduled' : 'submitted';
  const order = await SellOrder.findOne({ legacyListingId: listing.id }).select('status pickup verified paid');
  if (order) {
    const changed = order.status !== status || order.pickup !== Boolean(listing.pickup) || order.verified !== Boolean(listing.verified) || order.paid !== Boolean(listing.paid);
    const update: Record<string, unknown> = {
      status,
      pickup: Boolean(listing.pickup),
      pickedUpAt: listing.pickedUpAt ?? null,
      verified: Boolean(listing.verified),
      verifiedAt: listing.verifiedAt ?? null,
      verifiedBy: listing.verifiedBy ?? null,
      paid: Boolean(listing.paid),
      paidAt: listing.paidAt ?? null,
      paymentReference: listing.paymentReference ?? ''
    };
    const trackingEvent = { status, title: status.replace(/_/g, ' '), description: 'Updated from the operations workflow', timestamp: new Date() };
    await SellOrder.updateOne({ _id: order.id }, changed ? { $set: update, $push: { trackingHistory: { $each: [trackingEvent] } } } : { $set: update });
  }
  await syncSourceSellOrder(listing);
};
const activePickupStatuses = new Set(['Assigned', 'Accepted', 'En Route', 'Arrived', 'Collected', 'Handover Pending']);
const reconcilePickupState = async (listing: any) => {
  const assignment = await Pickup.findOne({ listing: listing.id }).sort({ createdAt: -1 });
  if (!assignment) {
    if (listing.assignedPartner || (!listing.pickup && listing.pickupStatus !== 'Unassigned')) {
      listing.assignedPartner = undefined;
      if (!listing.pickup) listing.pickupStatus = 'Unassigned';
      await listing.save();
    }
    return null;
  }
  if (activePickupStatuses.has(assignment.status)) {
    const changed = listing.assignedPartner?.toString() !== assignment.partner.toString() || listing.pickupStatus !== assignment.status;
    if (changed) {
      listing.assignedPartner = assignment.partner;
      listing.pickupStatus = assignment.status;
      await listing.save();
    }
  }
  return assignment;
};
let sourceConnectionPromise: Promise<mongoose.Connection> | undefined;
const getSourceConnection = async () => {
  if (!userMongoUri) throw new Error('USER_MONGO_URI is required to synchronize user-app listings');
  sourceConnectionPromise ??= mongoose.createConnection(userMongoUri, { dbName: userMongoDb }).asPromise();
  return sourceConnectionPromise;
};
const syncSourceSellOrder = async (listing: any) => {
  const sourceConnection = await getSourceConnection();
  const sourceDb = sourceConnection.db;
  if (!sourceDb) throw new Error('User-app database connection is not ready');
  const sourceOrders = sourceDb.collection<any>('sellorders');
  const sourceOrder = listing.sourceOrderId
    ? await sourceOrders.findOne({ _id: listing.sourceOrderId })
    : await sourceOrders.findOne({ orderNumber: listing.reference });
  const fallbackOrder = sourceOrder ?? await sourceOrders.findOne({ orderNumber: listing.reference });
  if (!fallbackOrder) throw new Error(`Source order ${listing.reference} was not found in the user-app database`);
  const status = listing.status === 'Cancelled' || listing.status === 'Rejected'
    ? 'cancelled'
    : listing.paid
      ? 'completed_paid'
      : listing.verified
        ? 'inspected_verified'
        : listing.pickup || listing.pickupStatus !== 'Unassigned'
          ? 'pickup_scheduled'
          : 'submitted';
  const update = {
    status,
    pickup: Boolean(listing.pickup),
    pickedUpAt: listing.pickedUpAt ?? null,
    verified: Boolean(listing.verified),
    verifiedAt: listing.verifiedAt ?? null,
    paid: Boolean(listing.paid),
    paidAt: listing.paidAt ?? null,
    paymentReference: listing.paymentReference ?? ''
  };
  const changed = fallbackOrder.status !== status
    || fallbackOrder.pickup !== update.pickup
    || fallbackOrder.verified !== update.verified
    || fallbackOrder.paid !== update.paid
    || String(fallbackOrder.paymentReference ?? '') !== update.paymentReference;
  const filter = { _id: fallbackOrder._id };
  const updateOperation: Record<string, unknown> = { $set: update };
  if (changed) {
    updateOperation.$push = {
      trackingHistory: {
        status,
        title: status.replace(/_/g, ' '),
        description: 'Updated from the operations workflow',
        timestamp: new Date()
      }
    };
  }
  await sourceOrders.updateOne(filter, updateOperation);
};
const syncUserAppListings = async () => {
  const sourceConnection = await getSourceConnection();
  const sourceDb = sourceConnection.db;
  if (!sourceDb) throw new Error('User-app database connection is not ready');
  const [sourceUsers, sourceOrders] = await Promise.all([
    sourceDb.collection<any>('users').find({ role: { $in: ['individual', 'bulk_institution'] } }).toArray(),
    sourceDb.collection<any>('sellorders').find({}).sort({ createdAt: 1 }).toArray()
  ]);
  const targetUsers = new Map<string, any>();
  for (const sourceUser of sourceUsers) {
    const email = String(sourceUser.email ?? '').trim().toLowerCase();
    if (!email) continue;
    let targetUser = await User.findOne({ email });
    if (targetUser && targetUser.role !== 'customer') continue;
    if (!targetUser) {
      const profile = sourceUser.role === 'bulk_institution' ? sourceUser.bulkProfile : sourceUser.individualProfile;
      targetUser = await User.create({
        email,
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
        name: profile?.organizationName || profile?.fullName || profile?.authorizedPerson || email.split('@')[0],
        role: 'customer',
        permissions: [],
        active: true,
        emailVerified: Boolean(sourceUser.isVerified),
        profile: {
          phone: profile?.contactPhone || profile?.phone || '',
          customerReference: undefined,
          sourceUserId: String(sourceUser._id)
        }
      });
      targetUser.set('profile.customerReference', targetUser.id);
      await targetUser.save();
    }
    targetUsers.set(String(sourceUser._id), targetUser);
  }
  for (const order of sourceOrders) {
    const targetUser = targetUsers.get(String(order.userId));
    if (!targetUser || !order.orderNumber) continue;
    const existing = await Listing.findOne({ reference: order.orderNumber });
    const status = order.status === 'completed_paid' ? 'Completed' : order.status === 'cancelled' ? 'Cancelled' : order.status === 'inspected_verified' ? 'Accepted' : order.status === 'pickup_scheduled' ? 'Approved' : 'Under Review';
    const pickupStatus = order.status === 'cancelled' ? 'Cancelled' : order.status === 'pickup_scheduled' ? 'Assigned' : 'Unassigned';
    const paymentStatus = order.status === 'completed_paid' ? 'Paid' : 'Not Initiated';
    const amountMinor = Math.round(Number(order.totalFinalPrice ?? 0) * 100);
    const { _id: sourceOrderId, createdAt: sourceCreatedAt, updatedAt: _sourceUpdatedAt, userId: _sourceUserId, ...sourceOrderFields } = order;
    const listing = existing ?? await Listing.create({
      reference: order.orderNumber,
      customerReference: targetUser.id,
      device: {
        category: order.category,
        model: order.brandAndModel || order.itemTitle,
        quantity: order.quantity ?? 1,
        condition: order.userReportedCondition ?? 'working',
        accessories: order.accessoriesIncluded ?? [],
        imageUrl: order.deviceImage ?? ''
      },
      detection: order.aiDetectionMeta ?? {},
      indicativeOfferMinor: amountMinor,
      provisionalPoints: order.carbonPointsAwarded ?? 0,
      pickup: false,
      verified: false,
      paid: false,
      status,
      pickupStatus,
      paymentStatus,
      address: {
        line1: order.pickupAddress?.street ?? '',
        city: order.pickupAddress?.city ?? '',
        postalCode: order.pickupAddress?.pincode ?? '',
        phone: order.pickupAddress?.contactPhone ?? ''
      },
      statusHistory: [{ status, actor: 'user-app-sync', createdAt: order.createdAt ?? new Date() }]
    });
    const hasReviewDecision = existing?.statusHistory?.some(entry => ['Approved', 'Rejected'].includes(entry.status ?? ''));
    const hasProgress = existing?.pickup || existing?.verified || existing?.paid || existing?.assignedPartner;
    if (existing && !hasReviewDecision && !hasProgress && ['Submitted', 'Under Review', 'Completed'].includes(existing.status)) {
      existing.status = status;
      existing.indicativeOfferMinor = amountMinor;
      existing.provisionalPoints = order.carbonPointsAwarded ?? 0;
      existing.pickupStatus = pickupStatus;
      existing.paymentStatus = paymentStatus;
      existing.set('sourceOrderId', String(sourceOrderId));
      await existing.save();
    }
    if (existing && order.status === 'completed_paid' && !existing.pickup && !existing.verified && !existing.paid) {
      existing.pickupStatus = 'Unassigned';
      existing.assignedPartner = undefined;
      await existing.save();
    }
    await SellOrder.updateOne(
      { orderNumber: order.orderNumber },
      { $setOnInsert: { ...sourceOrderFields, orderNumber: order.orderNumber, userId: targetUser.id, legacyListingId: listing.id, sourceOrderId: String(sourceOrderId), createdAt: sourceCreatedAt ?? new Date() } },
      { upsert: true }
    );
  }
};

app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('tiny'));
const uploadDirectory = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });
const evidenceUpload = multer({ dest: uploadDirectory, limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith('image/')) });
app.use('/uploads', express.static(uploadDirectory));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'techloop-api', timestamp: new Date().toISOString() }));
app.get('/api/v1/health/ai', async (_req, res) => {
  const url = process.env.YOLO_SERVICE_URL;
  if (!url) return res.json({ status: 'not_configured' });
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return res.json({ status: response.ok ? 'healthy' : 'unavailable' });
  } catch {
    return res.json({ status: 'unavailable' });
  }
});
app.get('/api/v1/catalog', async (_req, res, next) => {
  try {
    const items = await CatalogItem.find({ isActive: true }).sort({ category: 1, title: 1 }).select('-__v');
    return res.json({ items });
  } catch (error) { return next(error); }
});
app.post('/api/v1/staff', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ name: z.string().min(2).max(120), email: z.string().email(), password: z.string().min(8), permissions: z.array(z.string()).default([]) }).parse(req.body);
    if (await User.exists({ email: input.email })) return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'An account with this email already exists' } });
    const staff = await User.create({ name: input.name, email: input.email, passwordHash: await bcrypt.hash(input.password, 12), role: 'staff', permissions: input.permissions, active: true, emailVerified: true });
    return res.status(201).json({ staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role, active: staff.active, createdAt: staff.createdAt } });
  } catch (error) { return next(error); }
});
app.get('/api/v1/storage/summary', requireAuth, requireRole('staff'), async (_req, res, next) => {
  try {
    const collections = await mongoose.connection.db!.listCollections().toArray();
    const counts = await Promise.all(collections.map(async collection => ({
      name: collection.name,
      records: await mongoose.connection.db!.collection(collection.name).countDocuments()
    })));
    return res.json({
      database: mongoose.connection.db!.databaseName,
      host: mongoose.connection.host,
      collections: counts.sort((a, b) => a.name.localeCompare(b.name))
    });
  } catch (error) { return next(error); }
});

app.post('/api/v1/auth/login', async (req, res, next) => {
  try {
    const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await User.findOne({ email: input.email });
    if (!user || !user.active || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' } });
    if (privilegedRoles.has(user.role) && !isAuthorizedAdmin(user.email)) return res.status(403).json({ error: { code: 'ADMIN_NOT_AUTHORIZED', message: 'This admin account is not authorized' } });
    const token = jwt.sign({ id: user.id, role: user.role, permissions: user.permissions }, jwtSecret, { expiresIn: '8h' });
    return res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, permissions: user.permissions } });
  } catch (error) { return next(error); }
});
app.post('/api/v1/auth/signup', async (req, res, next) => {
  try {
    const input = z.object({ name: z.string().min(2).max(120), email: z.string().email(), password: z.string().min(8) }).parse(req.body);
    const exists = await User.exists({ email: input.email });
    if (exists) return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'An account with this email already exists' } });
    const user = await User.create({ ...input, passwordHash: await bcrypt.hash(input.password, 12), role: 'customer', permissions: [], active: true });
    return res.status(201).json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) { return next(error); }
});
app.get('/api/v1/auth/me', requireAuth, async (req: AuthRequest, res) => {
  const user = await User.findById(req.user!.id).select('-passwordHash');
  return res.json({ user });
});
app.post('/api/v1/orders', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'customer') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only customer accounts can create sell orders' } });
    const input = z.object({
      orderNumber: z.string().min(3).max(80),
      itemTitle: z.string().min(2).max(160),
      category: z.string().min(2).max(80),
      catalogItemId: z.string().optional(),
      deviceImage: z.string().max(500).optional(),
      brandAndModel: z.string().max(160).optional(),
      userReportedCondition: z.enum(['working', 'minor_scratches', 'screen_cracked', 'dead_scrap', 'bulk_mixed']).default('working'),
      accessoriesIncluded: z.array(z.string()).default([]),
      quantity: z.number().int().positive().default(1),
      agreedEstimatedPrice: z.number().nonnegative(),
      bonusAmountApplied: z.number().nonnegative().default(0),
      totalFinalPrice: z.number().nonnegative(),
      carbonPointsAwarded: z.number().int().nonnegative().default(0),
      pickupAddress: z.object({ street: z.string().min(1), city: z.string().min(1), state: z.string().min(1), pincode: z.string().min(1), contactPhone: z.string().min(7) }),
      pickupSlot: z.object({ date: z.string().default(''), timeWindow: z.string().default('10:00 AM - 01:00 PM') }).default({})
    }).parse(req.body);
    const listing = await Listing.create({
      reference: input.orderNumber,
      customerReference: req.user!.id,
      device: { category: input.category, model: input.brandAndModel ?? input.itemTitle, quantity: input.quantity, condition: input.userReportedCondition, accessories: input.accessoriesIncluded, imageUrl: input.deviceImage },
      indicativeOfferMinor: input.totalFinalPrice,
      provisionalPoints: input.carbonPointsAwarded,
      status: 'Submitted',
      pickupStatus: 'Unassigned',
      paymentStatus: 'Not Initiated',
      pickup: false,
      verified: false,
      paid: false,
      address: { line1: input.pickupAddress.street, city: input.pickupAddress.city, postalCode: input.pickupAddress.pincode, phone: input.pickupAddress.contactPhone },
      statusHistory: [{ status: 'Submitted', actor: req.user!.id, createdAt: new Date() }]
    });
    const order = await SellOrder.create({ ...input, userId: req.user!.id, legacyListingId: listing.id, pickup: false, verified: false, paid: false, trackingHistory: [{ status: 'submitted', title: 'Order submitted', description: 'Sell order submitted for review' }] });
    return res.status(201).json({ order, listing });
  } catch (error) { return next(error); }
});
app.get('/api/v1/orders', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const isAdmin = req.user!.role === 'staff' || req.user!.role === 'super_admin';
    const orders = await SellOrder.find(isAdmin ? {} : { userId: req.user!.id }).sort({ createdAt: -1 }).select('-__v');
    return res.json({ orders });
  } catch (error) { return next(error); }
});
app.patch('/api/v1/profile', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ name: z.string().min(2).max(120), password: z.string().min(8).max(200).optional() }).parse(req.body);
    const updates: Record<string, unknown> = { name: input.name };
    if (input.password) updates.passwordHash = await bcrypt.hash(input.password, 12);
    const user = await User.findByIdAndUpdate(req.user!.id, { $set: updates }, { new: true, runValidators: true }).select('-passwordHash');
    return res.json({ user });
  } catch (error) { return next(error); }
});
app.post('/api/v1/auth/password-reset/request', async (req, res, next) => {
  try {
    const input = z.object({ email: z.string().email() }).parse(req.body);
    const user = await User.findOne({ email: input.email, active: true });
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      await PasswordReset.create({ user: user.id, tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'), expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
    }
    return res.json({ message: 'If an active account exists, reset instructions will be sent to its email address.' });
  } catch (error) { return next(error); }
});
app.post('/api/v1/auth/password-reset/confirm', async (req, res, next) => {
  try {
    const input = z.object({ token: z.string().min(32), password: z.string().min(12).max(200) }).parse(req.body);
    const tokenHash = crypto.createHash('sha256').update(input.token).digest('hex');
    const reset = await PasswordReset.findOne({ tokenHash, usedAt: { $exists: false }, expiresAt: { $gt: new Date() } });
    if (!reset) return res.status(400).json({ error: { code: 'INVALID_RESET_TOKEN', message: 'The reset token is invalid or expired' } });
    const user = await User.findById(reset.user);
    if (!user || !user.active) return res.status(400).json({ error: { code: 'INVALID_RESET_TOKEN', message: 'The reset token is invalid or expired' } });
    user.passwordHash = await bcrypt.hash(input.password, 12);
    await user.save();
    reset.usedAt = new Date();
    await reset.save();
    return res.json({ reset: true });
  } catch (error) { return next(error); }
});
app.post('/api/v1/admin/users/:id/password-reset', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ password: z.string().min(12).max(200) }).parse(req.body);
    const user = await User.findById(req.params.id);
    if (!user || !['staff', 'delivery', 'technician'].includes(user.role)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Internal account not found' } });
    user.passwordHash = await bcrypt.hash(input.password, 12);
    await user.save();
    await writeAudit(req.user!.id, 'account.password_reset', 'user', user.id);
    return res.json({ reset: true, user: { id: user.id, email: user.email, active: user.active } });
  } catch (error) { return next(error); }
});

app.get('/api/v1/dashboard', requireAuth, requireRole('staff'), async (_req, res, next) => {
  try {
    await syncUserAppListings();
    const [total, review, accepted, pickups, inspection, processing, payments, points] = await Promise.all([
      Listing.countDocuments(), Listing.countDocuments({ status: 'Under Review' }), Listing.countDocuments({ status: 'Awaiting User Decision' }),
      Pickup.countDocuments({ status: { $in: ['Assigned', 'En Route', 'Arrived'] } }), Listing.countDocuments({ status: 'Accepted', pickupStatus: 'Handed Over' }),
      Listing.countDocuments({ status: 'Completed' }), Listing.countDocuments({ paymentStatus: { $in: ['Pending', 'Failed'] } }), Listing.countDocuments({ status: 'Completed' })
    ]);
    return res.json({ metrics: { total, review, accepted, pickups, inspection, processing, payments, points }, demoData: false });
  } catch (error) { return next(error); }
});

app.get('/api/v1/listings', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await syncUserAppListings();
    const page = Math.max(Number(req.query.page ?? 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
    const filter: Record<string, unknown> = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.user!.role === 'delivery') {
      const pickups = await Pickup.find({ partner: req.user!.id }).select('listing');
      filter._id = { $in: pickups.map((pickup) => pickup.listing) };
    }
    if ((req.user!.role === 'staff' || req.user!.role === 'super_admin') && req.query.includeHistory !== 'true') {
      filter.status = filter.status ?? { $nin: ['Completed', 'Cancelled', 'Rejected'] };
    }
    const [items, total] = await Promise.all([Listing.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), Listing.countDocuments(filter)]);
    await Promise.all(items.map(item => reconcilePickupState(item)));
    await Promise.all(items.map(item => item.populate('assignedPartner', 'name email')));
    const pickups = await Pickup.find({ listing: { $in: items.map(item => item.id) } }).select('listing evidence handover technician');
    const evidenceByListing = new Map(pickups.map(pickup => [pickup.listing.toString(), { evidence: pickup.evidence, handover: pickup.handover, technician: pickup.technician }]));
    const enrichedItems = items.map(item => ({ ...item.toObject(), pickup: evidenceByListing.get(item.id) }));
    return res.json({ items: enrichedItems, page, limit, total });
  } catch (error) { return next(error); }
});
app.get('/api/v1/listings/:id', requireAuth, async (req, res, next) => {
  try {
    const listing = await Listing.findById(req.params.id).populate('assignedPartner', 'name email');
    if (!listing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } });
    const [offers, pickup, audit] = await Promise.all([Offer.find({ listing: listing.id }).sort({ version: -1 }), Pickup.findOne({ listing: listing.id }).populate('partner', 'name email'), AuditLog.find({ entityId: listing.id }).sort({ createdAt: -1 })]);
    return res.json({ listing, offers, pickup, audit });
  } catch (error) { return next(error); }
});
app.delete('/api/v1/listings/:id', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } });
    await Promise.all([
      Pickup.deleteMany({ listing: listing.id }),
      Offer.deleteMany({ listing: listing.id }),
      AuditLog.deleteMany({ entityId: listing.id }),
      Listing.deleteOne({ _id: listing.id })
    ]);
    return res.json({ deleted: true, reference: listing.reference });
  } catch (error) { return next(error); }
});
app.post('/api/v1/listings/:id/review', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ status: z.enum(['Approved', 'Rejected', 'Awaiting User Decision']), reason: z.string().min(1).max(500) }).parse(req.body);
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } });
    if (['Approved', 'Rejected'].includes(listing.status) || listing.statusHistory.some(entry => ['Approved', 'Rejected'].includes(entry.status ?? ''))) return res.status(409).json({ error: { code: 'REVIEW_LOCKED', message: 'This listing has already received a review decision and cannot be reviewed again' } });
    await transition(listing, input.status, req.user!.id, input.reason);
    await syncSellOrder(listing);
    await writeAudit(req.user!.id, 'listing.reviewed', 'listing', listing.id, input.reason);
    return res.json({ listing });
  } catch (error) { return next(error); }
});
app.post('/api/v1/listings/:id/offers', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ amountMinor: z.number().int().nonnegative(), points: z.number().int().nonnegative(), reason: z.string().min(1).max(500) }).parse(req.body);
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } });
    if (['Approved', 'Rejected'].includes(listing.status)) return res.status(409).json({ error: { code: 'LISTING_LOCKED', message: `A ${listing.status.toLowerCase()} listing cannot receive another offer` } });
    const version = (await Offer.countDocuments({ listing: listing.id })) + 1;
    const offer = await Offer.create({ listing: listing.id, ...input, version, createdBy: req.user!.id });
    listing.indicativeOfferMinor = input.amountMinor; listing.provisionalPoints = input.points;
    await transition(listing, 'Awaiting User Decision', req.user!.id, input.reason);
    await writeAudit(req.user!.id, 'offer.created', 'listing', listing.id, input.reason);
    return res.status(201).json({ offer, listing });
  } catch (error) { return next(error); }
});

app.get('/api/v1/pickups/assignments', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const filter = req.user!.role === 'delivery' ? { partner: req.user!.id } : {};
    const items = await Pickup.find(filter).populate('listing').populate('partner', 'name email').populate('technician', 'name email profile').sort({ createdAt: -1 });
    return res.json({ items });
  } catch (error) { return next(error); }
});
app.get('/api/v1/partners', requireAuth, requireRole('staff'), async (_req, res, next) => {
  try {
    const items = await User.find({ role: 'delivery' }).select('name email profile active createdAt').sort({ name: 1 });
    return res.json({ items });
  } catch (error) { return next(error); }
});
app.post('/api/v1/partners', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ name: z.string().min(2).max(120), email: z.string().email(), phone: z.string().min(7).max(30), password: z.string().min(8), contractEndsAt: z.string().datetime().optional() }).parse(req.body);
    const exists = await User.exists({ email: input.email });
    if (exists) return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'An account with this email already exists' } });
    const partner = await User.create({ name: input.name, email: input.email, passwordHash: await bcrypt.hash(input.password, 12), role: 'delivery', permissions: ['pickup:read', 'pickup:update'], active: true, profile: { phone: input.phone, contractEndsAt: input.contractEndsAt } });
    return res.status(201).json({ partner: { id: partner.id, name: partner.name, email: partner.email } });
  } catch (error) { return next(error); }
});
app.patch('/api/v1/partners/:id', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ name: z.string().min(2).max(120), email: z.string().email(), phone: z.string().min(7).max(30), password: z.string().min(8).optional() }).parse(req.body);
    const existing = await User.findOne({ _id: req.params.id, role: 'delivery' }).select('email');
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Delivery partner not found' } });
    if (input.email.toLowerCase() !== existing.email.toLowerCase()) return res.status(403).json({ error: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'Email changes require verified email ownership and must be completed through account support' } });
    const conflict = await User.findOne({ email: input.email, _id: { $ne: req.params.id } });
    if (conflict) return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'That email is already in use' } });
    const updates: Record<string, unknown> = { name: input.name, email: input.email, 'profile.phone': input.phone };
    if (input.password) updates.passwordHash = await bcrypt.hash(input.password, 12);
    const partner = await User.findOneAndUpdate({ _id: req.params.id, role: 'delivery' }, { $set: updates }, { new: true, runValidators: true }).select('name email profile active createdAt');
    return res.json({ partner });
  } catch (error) { return next(error); }
});
app.delete('/api/v1/partners/:id', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const partner = await User.findOneAndUpdate({ _id: req.params.id, role: 'delivery', active: true }, { $set: { active: false } }, { new: true }).select('name email active');
    if (!partner) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Active delivery partner not found' } });
    await writeAudit(req.user!.id, 'partner.deactivated', 'user', partner.id, 'Delivery partner removed by operations');
    return res.json({ partner });
  } catch (error) { return next(error); }
});
app.get('/api/v1/technicians', requireAuth, requireRole('staff'), async (_req, res, next) => {
  try {
    const items = await User.find({ role: 'technician' }).select('name email profile active createdAt').sort({ name: 1 });
    return res.json({ items });
  } catch (error) { return next(error); }
});
app.post('/api/v1/technicians', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ name: z.string().min(2).max(120), email: z.string().email(), phone: z.string().min(7).max(30), specialization: z.string().min(2).max(120), password: z.string().min(8), contractEndsAt: z.string().datetime().optional() }).parse(req.body);
    const exists = await User.exists({ email: input.email });
    if (exists) return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'That email is already in use' } });
    const technician = await User.create({ name: input.name, email: input.email, passwordHash: await bcrypt.hash(input.password, 12), role: 'technician', permissions: [], active: true, profile: { phone: input.phone, specialization: input.specialization, contractEndsAt: input.contractEndsAt } });
    return res.status(201).json({ technician: { id: technician.id, name: technician.name, email: technician.email } });
  } catch (error) { return next(error); }
});
app.patch('/api/v1/technicians/:id', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ name: z.string().min(2).max(120), email: z.string().email(), phone: z.string().min(7).max(30), specialization: z.string().min(2).max(120), password: z.string().min(8).optional() }).parse(req.body);
    const existing = await User.findOne({ _id: req.params.id, role: 'technician' }).select('email');
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Technical partner not found' } });
    if (input.email.toLowerCase() !== existing.email.toLowerCase()) return res.status(403).json({ error: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'Email changes require verified email ownership and must be completed through account support' } });
    const conflict = await User.findOne({ email: input.email, _id: { $ne: req.params.id } });
    if (conflict) return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'That email is already in use' } });
    const updates: Record<string, unknown> = { name: input.name, email: input.email, 'profile.phone': input.phone, 'profile.specialization': input.specialization };
    if (input.password) updates.passwordHash = await bcrypt.hash(input.password, 12);
    const technician = await User.findOneAndUpdate({ _id: req.params.id, role: 'technician' }, { $set: updates }, { new: true, runValidators: true }).select('name email profile active createdAt');
    return res.json({ technician });
  } catch (error) { return next(error); }
});
app.delete('/api/v1/technicians/:id', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const technician = await User.findOneAndUpdate({ _id: req.params.id, role: 'technician', active: true }, { $set: { active: false } }, { new: true }).select('name email active');
    if (!technician) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Active technical partner not found' } });
    await writeAudit(req.user!.id, 'technician.deactivated', 'user', technician.id, 'Technical partner removed by operations');
    return res.json({ technician });
  } catch (error) { return next(error); }
});
app.get('/api/v1/customers', requireAuth, requireRole('staff'), async (_req, res, next) => {
  try {
    const items = await User.find({ role: 'customer', active: true }).select('name email createdAt profile').sort({ createdAt: -1 });
    return res.json({ items });
  } catch (error) { return next(error); }
});
app.get('/api/v1/wallets/summary', requireAuth, requireRole('staff'), async (_req, res, next) => {
  try {
    const items = await Wallet.find().populate('user', 'name email').sort({ updatedAt: -1 });
    return res.json({ items });
  } catch (error) { return next(error); }
});
app.get('/api/v1/rewards', requireAuth, requireRole('staff'), async (_req, res, next) => {
  try {
    const [rewards, redemptions] = await Promise.all([
      Reward.find({ active: true }).sort({ type: 1, pointsRequired: 1 }),
      Redemption.find().populate('reward', 'name type pointsRequired valueMinor').sort({ createdAt: -1 })
    ]);
    return res.json({ rewards, redemptions });
  } catch (error) { return next(error); }
});
app.post('/api/v1/rewards', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({
      name: z.string().min(2).max(120),
      type: z.enum(['basic', 'advanced']),
      pointsRequired: z.number().int().positive(),
      valueMinor: z.number().int().positive(),
      description: z.string().max(300).optional()
    }).parse(req.body);
    const minimum = input.type === 'basic' ? 1500 : 3000;
    if (input.pointsRequired < minimum) return res.status(400).json({ error: { code: 'REWARD_THRESHOLD', message: `${input.type} rewards must require at least ${minimum} points` } });
    const reward = await Reward.create({ ...input, createdBy: req.user!.id });
    return res.status(201).json({ reward });
  } catch (error) { return next(error); }
});
app.post('/api/v1/rewards/:id/redemptions', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ customerReference: z.string().min(2).max(80) }).parse(req.body);
    const reward = await Reward.findOne({ _id: req.params.id, active: true });
    if (!reward) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reward not found' } });
    const wallet = await Wallet.findOne({ customerReference: input.customerReference });
    if (!wallet || wallet.balance < reward.pointsRequired) return res.status(400).json({ error: { code: 'INSUFFICIENT_POINTS', message: 'Customer does not have enough carbon points' } });
    const balanceAfter = wallet.balance - reward.pointsRequired;
    await Wallet.updateOne({ _id: wallet.id, balance: { $gte: reward.pointsRequired } }, {
      $inc: { balance: -reward.pointsRequired },
      $push: { transactions: { reference: `REDEEM-${Date.now()}`, type: 'Debit', points: reward.pointsRequired, reason: `Redeemed ${reward.name}`, status: 'Redeemed', createdAt: new Date() } }
    });
    const redemption = await Redemption.create({ reward: reward.id, customerReference: input.customerReference, user: wallet.user, points: reward.pointsRequired, createdBy: req.user!.id });
    return res.status(201).json({ redemption, balance: balanceAfter });
  } catch (error) { return next(error); }
});
app.post('/api/v1/pickups/assignments', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ listingId: z.string(), partnerId: z.string(), technicianId: z.string().optional(), window: z.string().min(1), priority: z.enum(['Standard', 'High', 'Urgent']).default('Standard'), instructions: z.string().max(500).optional() }).parse(req.body);
    const listing = await Listing.findById(input.listingId);
    const partner = await User.findOne({ _id: input.partnerId, role: 'delivery', active: true });
    const technician = input.technicianId ? await User.findOne({ _id: input.technicianId, role: 'technician', active: true }) : undefined;
    if (!listing || !partner || (input.technicianId && !technician)) return res.status(400).json({ error: { code: 'INVALID_ASSIGNMENT', message: 'Listing, delivery partner, or technician is invalid' } });
    if (['Approved', 'Rejected'].includes(listing.status) === false) return res.status(409).json({ error: { code: 'LISTING_NOT_APPROVED', message: 'Only an approved listing can be assigned for pickup' } });
    const existingPickup = await reconcilePickupState(listing);
    if (existingPickup && activePickupStatuses.has(existingPickup.status)) {
      return res.status(409).json({ error: { code: 'PICKUP_ALREADY_EXISTS', message: 'This listing already has an active pickup assignment' } });
    }
    const pickup = await Pickup.create({ listing: listing.id, partner: partner.id, technician: technician?.id, window: input.window, priority: input.priority, instructions: input.instructions, status: 'Assigned', events: [{ status: 'Assigned', actor: req.user!.id, createdAt: new Date() }] });
    listing.assignedPartner = partner.id; listing.pickupStatus = 'Assigned'; await listing.save();
    await syncSellOrder(listing);
    await writeAudit(req.user!.id, 'pickup.assigned', 'pickup', pickup.id);
    return res.status(201).json({ pickup });
  } catch (error) { return next(error); }
});
app.post('/api/v1/pickups/assignments/:id/events', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ status: z.enum(pickupStatusValues), reason: z.string().max(500).optional(), checklist: z.array(z.string()).optional(), notes: z.string().max(1000).optional() }).parse(req.body);
    const pickup = await Pickup.findById(req.params.id).populate('listing');
    if (!pickup || !['delivery', 'staff', 'super_admin'].includes(req.user!.role) || (req.user!.role === 'delivery' && pickup.partner.toString() !== req.user!.id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Assignment not found' } });
    if (req.user!.role === 'delivery' && ['Failed', 'Handed Over'].includes(pickup.status)) return res.status(409).json({ error: { code: 'PICKUP_LOCKED', message: 'This pickup is closed. Operations must create a new assignment if a retry is approved.' } });
    if (input.status === 'Failed' && !input.reason?.trim()) return res.status(400).json({ error: { code: 'FAILURE_REASON_REQUIRED', message: 'Explain why the pickup failed' } });
    if (pickup.status === input.status) return res.json({ pickup, duplicate: true });
    pickup.status = input.status; pickup.events.push({ status: input.status, reason: input.reason, actor: req.user!.id, createdAt: new Date() });
    if (input.checklist || input.notes) pickup.evidence = { ...pickup.evidence, checklist: input.checklist ?? pickup.evidence?.checklist ?? [], notes: input.notes ?? pickup.evidence?.notes };
    await pickup.save();
    const listing = await Listing.findById(pickup.listing);
    if (listing) {
      listing.pickupStatus = input.status;
      if (input.status === 'Failed') listing.failedPickupReason = input.reason;
      if (input.status === 'Collected' || input.status === 'Handed Over') {
        listing.pickup = true;
        listing.pickedUpAt ??= new Date();
      }
      await listing.save();
      await syncSellOrder(listing);
    }
    return res.json({ pickup });
  } catch (error) { return next(error); }
});
app.post('/api/v1/listings/:id/inspection', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ decision: z.enum(['Accepted', 'Rejected']), notes: z.string().min(1).max(1000) }).parse(req.body);
    const listing = await Listing.findById(req.params.id);
    if (!listing || !['Collected', 'Handover Pending', 'Handed Over'].includes(listing.pickupStatus)) return res.status(409).json({ error: { code: 'NOT_READY_FOR_INSPECTION', message: 'Only collected pickups can be inspected' } });
    if (['Accepted', 'Rejected'].includes(listing.status)) return res.status(409).json({ error: { code: 'INSPECTION_LOCKED', message: 'This pickup has already been inspected' } });
    await transition(listing, input.decision, req.user!.id, input.notes);
    listing.verified = input.decision === 'Accepted';
    listing.verifiedAt = input.decision === 'Accepted' ? new Date() : null;
    listing.verifiedBy = input.decision === 'Accepted' ? new mongoose.Types.ObjectId(req.user!.id) : null;
    listing.inspectionNotes = input.notes;
    await listing.save();
    await syncSellOrder(listing);
    await writeAudit(req.user!.id, 'listing.inspected', 'listing', listing.id, input.notes);
    return res.json({ listing });
  } catch (error) { return next(error); }
});
app.post('/api/v1/listings/:id/payment', requireAuth, requireRole('staff'), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ amountMinor: z.number().int().nonnegative(), reference: z.string().min(3).max(120) }).parse(req.body);
    const listing = await Listing.findById(req.params.id);
    if (!listing || listing.status !== 'Accepted' || !listing.verified) return res.status(409).json({ error: { code: 'NOT_READY_FOR_PAYMENT', message: 'Only verified inspections can be paid' } });
    if (listing.paid === true) return res.json({ listing, payment: { amountMinor: input.amountMinor, reference: input.reference, status: 'Paid' }, points: { credited: 0, balance: 0, customerReference: listing.customerReference }, alreadyPaid: true });
    const paidAt = new Date();
    const customer = await User.findOne({ role: 'customer', 'profile.customerReference': listing.customerReference });
    const points = listing.provisionalPoints ?? 0;
    const pointsReference = `PTS-${listing.reference}`;
    const walletFilter = customer ? { user: customer.id, transactions: { $not: { $elemMatch: { reference: pointsReference } } } } : { customerReference: listing.customerReference, transactions: { $not: { $elemMatch: { reference: pointsReference } } } };
    const wallet = await Wallet.findOneAndUpdate(
      walletFilter,
      {
        $setOnInsert: { user: customer?.id, customerReference: listing.customerReference },
        $inc: { balance: points },
        $push: { transactions: { reference: pointsReference, type: 'Credit', points, reason: `Payment completed for ${listing.reference}`, status: 'Credited', createdAt: new Date() } }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const walletRecord = wallet ?? await Wallet.findOne(customer ? { user: customer.id } : { customerReference: listing.customerReference });
    if (!walletRecord) return res.status(500).json({ error: { code: 'WALLET_UPDATE_FAILED', message: 'Payment could not be reconciled with the customer wallet' } });
    const order = await SellOrder.findOne({ legacyListingId: listing.id });
    if (order && points > 0) {
      await CarbonLedger.findOneAndUpdate(
        { userId: order.userId, history: { $not: { $elemMatch: { orderId: order.id } } } },
        { $setOnInsert: { userId: order.userId }, $inc: { totalCarbonPoints: points, totalKgDiverted: points / 1000 }, $push: { history: { orderId: order.id, gramsCo2Saved: points, pointsEarned: points, deviceDescription: listing.device?.model ?? listing.reference, timestamp: new Date() } } },
        { upsert: true, new: true }
      );
    }
    const paymentUpdate = await Listing.updateOne({ _id: listing.id, status: 'Accepted', verified: true, paid: { $ne: true }, paymentStatus: { $ne: 'Paid' } }, { $set: { paymentStatus: 'Paid', paid: true, paidAt, paymentReference: input.reference } });
    const paidListing = await Listing.findById(listing.id);
    if (!paidListing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found after payment' } });
    await writeAudit(req.user!.id, 'listing.payment_recorded', 'listing', listing.id, input.reference);
    await writeAudit(req.user!.id, 'wallet.points_credited', 'wallet', walletRecord.id, `${points} points for ${listing.reference}`);
    await syncSellOrder(paidListing);
    return res.json({ listing: paidListing, payment: { amountMinor: input.amountMinor, reference: input.reference, status: 'Paid' }, points: { credited: paymentUpdate.modifiedCount ? points : 0, balance: walletRecord.balance, customerReference: listing.customerReference }, alreadyPaid: paymentUpdate.modifiedCount === 0 });
  } catch (error) { return next(error); }
});
app.post('/api/v1/pickups/assignments/:id/evidence', requireAuth, requireRole('delivery'), evidenceUpload.single('photo'), async (req: AuthRequest, res, next) => {
  try {
    const pickup = await Pickup.findById(req.params.id);
    if (!pickup || pickup.partner.toString() !== req.user!.id) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Assignment not found' } });
    if (!req.file) return res.status(400).json({ error: { code: 'PHOTO_REQUIRED', message: 'A pickup photo is required' } });
    pickup.evidence = { checklist: pickup.evidence?.checklist ?? [], ...pickup.evidence, photoUrl: `/uploads/${req.file.filename}`, notes: req.body.notes ?? pickup.evidence?.notes };
    await pickup.save();
    await writeAudit(req.user!.id, 'pickup.evidence_uploaded', 'pickup', pickup.id);
    return res.status(201).json({ evidence: pickup.evidence });
  } catch (error) { return next(error); }
});
app.post('/api/v1/support/issues', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ subject: z.string().min(3).max(120), message: z.string().min(10).max(2000), pickupId: z.string().optional() }).parse(req.body);
    const issue = await AuditLog.create({ actor: req.user!.id, action: 'support.issue_created', entityType: 'support', entityId: input.pickupId ?? req.user!.id, reason: input.subject, metadata: { message: input.message, status: 'Open' } });
    return res.status(201).json({ issue: { id: issue.id, status: 'Open', createdAt: issue.createdAt } });
  } catch (error) { return next(error); }
});
app.post('/api/v1/pickups/assignments/:id/handover', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ receiver: z.string().min(1), quantity: z.number().int().positive(), notes: z.string().max(500).optional() }).parse(req.body);
    const pickup = await Pickup.findById(req.params.id);
    if (!pickup || !['delivery', 'staff', 'super_admin'].includes(req.user!.role) || (req.user!.role === 'delivery' && pickup.partner.toString() !== req.user!.id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Assignment not found' } });
    if (pickup.status === 'Handed Over') return res.json({ pickup, duplicate: true });
    pickup.handover = { ...input, confirmedAt: new Date() }; pickup.status = 'Handed Over'; pickup.events.push({ status: 'Handed Over', actor: req.user!.id, createdAt: new Date() }); await pickup.save();
    await Listing.findByIdAndUpdate(pickup.listing, { pickupStatus: 'Handed Over', pickup: true, pickedUpAt: new Date() });
    const handedOverListing = await Listing.findById(pickup.listing);
    if (handedOverListing) await syncSellOrder(handedOverListing);
    return res.json({ pickup });
  } catch (error) { return next(error); }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.issues[0]?.message ?? 'Invalid request' } });
  console.error(error);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
});

const start = async () => {
  await mongoose.connect(mongoUri);
  app.listen(port, () => console.log(`TechLoop API listening on http://localhost:${port}`));
};
if (process.env.NODE_ENV !== 'test') start().catch((error) => { console.error(error); process.exitCode = 1; });
export { app };
