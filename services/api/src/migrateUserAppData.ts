import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import mongoose, { Types } from 'mongoose';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

type SourceUser = {
  _id: Types.ObjectId;
  email: string;
  role?: 'individual' | 'bulk_institution' | 'admin';
  isVerified?: boolean;
  individualProfile?: {
    fullName?: string;
    phone?: string;
    defaultAddress?: { street?: string; city?: string; state?: string; pincode?: string };
  };
  bulkProfile?: {
    organizationName?: string;
    authorizedPerson?: string;
    contactPhone?: string;
    facilityAddress?: { street?: string; city?: string; state?: string; pincode?: string };
  };
};

type SourceCatalogItem = {
  _id: Types.ObjectId;
  title: string;
  category: string;
  description?: string;
  imageUrl?: string;
  iconName?: string;
  basePriceMin: number;
  basePriceMax: number;
  estimatedPayoutTime?: string;
  co2SavingsGrams?: number;
  materialsRecoverable?: Array<{ name?: string; percentageOrGrams?: string }>;
  bonusCampaign?: Record<string, unknown>;
  isActive?: boolean;
};

type SourceSellOrder = {
  _id: Types.ObjectId;
  orderNumber: string;
  userId: Types.ObjectId;
  roleType?: 'individual' | 'bulk_institution';
  catalogItemId?: Types.ObjectId | null;
  itemTitle: string;
  category: string;
  deviceImage?: string;
  aiDetectionMeta?: Record<string, unknown>;
  userReportedCondition?: string;
  brandAndModel?: string;
  accessoriesIncluded?: string[];
  quantity?: number;
  agreedEstimatedPrice: number;
  bonusAmountApplied?: number;
  totalFinalPrice: number;
  estimatedPayoutTime?: string;
  carbonPointsAwarded?: number;
  pickupAddress: { street: string; city: string; state: string; pincode: string; contactPhone: string };
  pickupSlot?: { date?: string; timeWindow?: string };
  status?: 'submitted' | 'pickup_scheduled' | 'inspected_verified' | 'completed_paid' | 'cancelled';
  trackingHistory?: Array<{ status: string; title: string; description?: string; timestamp?: Date }>;
  createdAt?: Date;
  updatedAt?: Date;
};

const targetUri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/techloop';
const sourceUri = process.env.USER_MONGO_URI;
const sourceDbName = process.env.USER_MONGO_DB ?? 'innotech_ewaste';

if (!sourceUri) {
  throw new Error('USER_MONGO_URI is required to import user-app data');
}

const asObjectId = (value: unknown) => value instanceof Types.ObjectId ? value : new Types.ObjectId(String(value));
const nonEmpty = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value.trim() : fallback;

const addressForUser = (user: SourceUser) => {
  const source = user.role === 'bulk_institution' ? user.bulkProfile?.facilityAddress : user.individualProfile?.defaultAddress;
  return {
    line1: nonEmpty(source?.street, ''),
    city: nonEmpty(source?.city, ''),
    postalCode: nonEmpty(source?.pincode, ''),
    phone: nonEmpty(user.role === 'bulk_institution' ? user.bulkProfile?.contactPhone : user.individualProfile?.phone, '')
  };
};

const nameForUser = (user: SourceUser) => user.role === 'bulk_institution'
  ? nonEmpty(user.bulkProfile?.organizationName, nonEmpty(user.bulkProfile?.authorizedPerson, user.email.split('@')[0]))
  : nonEmpty(user.individualProfile?.fullName, user.email.split('@')[0]);

const listingStatus = (status: SourceSellOrder['status']) => ({
  submitted: { status: 'Under Review', pickupStatus: 'Unassigned', paymentStatus: 'Not Initiated' },
  pickup_scheduled: { status: 'Approved', pickupStatus: 'Assigned', paymentStatus: 'Not Initiated' },
  inspected_verified: { status: 'Accepted', pickupStatus: 'Handed Over', paymentStatus: 'Not Initiated' },
  completed_paid: { status: 'Completed', pickupStatus: 'Handed Over', paymentStatus: 'Paid' },
  cancelled: { status: 'Cancelled', pickupStatus: 'Cancelled', paymentStatus: 'Not Initiated' }
}[status ?? 'submitted']);

const migrate = async () => {
  await mongoose.connect(targetUri);
  const source = await mongoose.createConnection(sourceUri, { dbName: sourceDbName }).asPromise();
  const targetDb = mongoose.connection.db!;
  const sourceDb = source.db!;

  const sourceUsers = await sourceDb.collection<SourceUser>('users').find({ role: { $in: ['individual', 'bulk_institution'] } }).toArray();
  const sourceCatalog = await sourceDb.collection<SourceCatalogItem>('catalogitems').find({}).toArray();
  const sourceOrders = await sourceDb.collection<SourceSellOrder>('sellorders').find({}).sort({ createdAt: 1 }).toArray();
  const userIds = new Map<string, Types.ObjectId>();
  const catalogIds = new Map<string, Types.ObjectId>();
  let customersCreated = 0;
  let customersReused = 0;
  let catalogCreated = 0;
  let ordersImported = 0;
  let listingsCreated = 0;
  let ordersLinked = 0;

  for (const sourceUser of sourceUsers) {
    const email = sourceUser.email.trim().toLowerCase();
    let targetUser = await targetDb.collection('users').findOne({ email }, { projection: { _id: 1, role: 1 } });
    if (targetUser && targetUser.role !== 'customer') {
      throw new Error(`Cannot import source customer ${email}: target account already uses role ${targetUser.role}`);
    }
    if (!targetUser) {
      const _id = new Types.ObjectId();
      await targetDb.collection('users').insertOne({
        _id,
        email,
        emailVerified: Boolean(sourceUser.isVerified),
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
        name: nameForUser(sourceUser),
        role: 'customer',
        permissions: [],
        active: true,
        profile: {
          phone: nonEmpty(sourceUser.role === 'bulk_institution' ? sourceUser.bulkProfile?.contactPhone : sourceUser.individualProfile?.phone, ''),
          customerReference: _id.toString()
        },
        sourceUserId: sourceUser._id.toString(),
        createdAt: new Date(),
        updatedAt: new Date()
      });
      targetUser = { _id, role: 'customer' };
      customersCreated += 1;
    } else {
      customersReused += 1;
      await targetDb.collection('users').updateOne(
        { _id: targetUser._id },
        { $set: { 'profile.customerReference': targetUser._id.toString(), sourceUserId: sourceUser._id.toString(), updatedAt: new Date() } }
      );
    }
    userIds.set(sourceUser._id.toString(), asObjectId(targetUser._id));
  }

  for (const item of sourceCatalog) {
    const existing = await targetDb.collection('catalogitems').findOne({ title: item.title, category: item.category }, { projection: { _id: 1 } });
    const targetId = existing?._id ?? new Types.ObjectId();
    if (!existing) {
      await targetDb.collection('catalogitems').insertOne({
        _id: targetId,
        title: item.title,
        category: item.category,
        description: item.description ?? '',
        imageUrl: item.imageUrl ?? '',
        iconName: item.iconName ?? 'phone_android',
        basePriceMin: item.basePriceMin,
        basePriceMax: item.basePriceMax,
        estimatedPayoutTime: item.estimatedPayoutTime ?? 'Within 2 hours of pickup',
        co2SavingsGrams: item.co2SavingsGrams ?? 25000,
        materialsRecoverable: item.materialsRecoverable ?? [],
        bonusCampaign: item.bonusCampaign ?? {},
        isActive: item.isActive !== false,
        sourceCatalogItemId: item._id.toString(),
        createdAt: new Date(),
        updatedAt: new Date()
      });
      catalogCreated += 1;
    }
    catalogIds.set(item._id.toString(), asObjectId(targetId));
  }

  for (const order of sourceOrders) {
    const targetUserId = userIds.get(order.userId.toString());
    if (!targetUserId) continue;
    const state = listingStatus(order.status);
    let listing = await targetDb.collection('listings').findOne({ reference: order.orderNumber }, { projection: { _id: 1 } });
    if (!listing) {
      const listingId = new Types.ObjectId();
      await targetDb.collection('listings').insertOne({
        _id: listingId,
        reference: order.orderNumber,
        customerReference: targetUserId.toString(),
        device: {
          category: order.category,
          model: order.brandAndModel || order.itemTitle,
          quantity: order.quantity ?? 1,
          condition: order.userReportedCondition ?? 'working',
          accessories: order.accessoriesIncluded ?? [],
          imageUrl: order.deviceImage ?? ''
        },
        detection: order.aiDetectionMeta ?? {},
        indicativeOfferMinor: Math.round(Number(order.totalFinalPrice ?? 0) * 100),
        provisionalPoints: order.carbonPointsAwarded ?? 0,
        pickup: false,
        verified: false,
        paid: false,
        ...state,
        address: addressForUser(sourceUsers.find(user => user._id.toString() === order.userId.toString())!),
        statusHistory: [{ status: state.status, actor: 'user-app-import', createdAt: order.createdAt ?? new Date() }],
        createdAt: order.createdAt ?? new Date(),
        updatedAt: order.updatedAt ?? new Date(),
        sourceOrderId: order._id.toString()
      });
      listing = { _id: listingId };
      listingsCreated += 1;
    } else {
      await targetDb.collection('listings').updateOne(
        { _id: listing._id },
        {
          $set: {
            indicativeOfferMinor: Math.round(Number(order.totalFinalPrice ?? 0) * 100),
            provisionalPoints: order.carbonPointsAwarded ?? 0,
            ...state,
            sourceOrderId: order._id.toString(),
            updatedAt: new Date()
          }
        }
      );
    }
    const targetCatalogId = order.catalogItemId ? catalogIds.get(order.catalogItemId.toString()) : undefined;
    const sourceFields = {
      roleType: order.roleType ?? 'individual',
      catalogItemId: targetCatalogId ?? null,
      itemTitle: order.itemTitle,
      category: order.category,
      deviceImage: order.deviceImage ?? '',
      aiDetectionMeta: order.aiDetectionMeta ?? {},
      userReportedCondition: order.userReportedCondition ?? 'working',
      brandAndModel: order.brandAndModel ?? '',
      accessoriesIncluded: order.accessoriesIncluded ?? [],
      quantity: order.quantity ?? 1,
      agreedEstimatedPrice: order.agreedEstimatedPrice,
      bonusAmountApplied: order.bonusAmountApplied ?? 0,
      totalFinalPrice: order.totalFinalPrice,
      estimatedPayoutTime: order.estimatedPayoutTime ?? 'Within 2 hours of pickup',
      carbonPointsAwarded: order.carbonPointsAwarded ?? 0,
      pickupAddress: order.pickupAddress,
      pickupSlot: order.pickupSlot ?? {},
      status: order.status ?? 'submitted',
      trackingHistory: order.trackingHistory ?? [],
      sourceOrderId: order._id.toString()
    };
    const result = await targetDb.collection('sellorders').updateOne(
      { orderNumber: order.orderNumber },
      { $setOnInsert: { ...sourceFields, orderNumber: order.orderNumber, createdAt: order.createdAt ?? new Date() }, $set: { legacyListingId: listing._id, userId: targetUserId, updatedAt: new Date() } },
      { upsert: true }
    );
    if (result.upsertedCount) ordersImported += 1;
    else ordersLinked += 1;
  }

  await source.close();
  await mongoose.disconnect();
  console.log(JSON.stringify({ sourceDatabase: sourceDbName, sourceUsers: sourceUsers.length, sourceCatalogItems: sourceCatalog.length, sourceOrders: sourceOrders.length, customersCreated, customersReused, catalogCreated, ordersImported, ordersLinked, listingsCreated }));
};

migrate().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await mongoose.disconnect();
  process.exitCode = 1;
});
