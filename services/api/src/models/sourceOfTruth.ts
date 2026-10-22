import mongoose, { Schema } from 'mongoose';

const addressSchema = new Schema({
  street: { type: String, default: '' },
  city: { type: String, default: '' },
  state: { type: String, default: '' },
  pincode: { type: String, default: '' }
}, { _id: false });

const sourceUserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  role: { type: String, enum: ['individual', 'bulk_institution', 'admin'], default: 'individual' },
  isVerified: { type: Boolean, default: false },
  otpCode: { type: String, default: null, select: false },
  otpExpiresAt: { type: Date, default: null, select: false },
  refreshToken: { type: String, default: null, select: false },
  individualProfile: {
    fullName: { type: String, default: '' },
    phone: { type: String, default: '' },
    defaultAddress: { type: addressSchema, default: () => ({}) },
    upiId: { type: String, default: '' }
  },
  bulkProfile: {
    organizationName: { type: String, default: '' },
    orgType: { type: String, enum: ['college', 'tech_company', 'school', 'hospital', 'other'], default: 'tech_company' },
    gstNumber: { type: String, default: '' },
    authorizedPerson: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    facilityAddress: { type: addressSchema, default: () => ({}) }
  }
}, { timestamps: true, collection: 'users' });

const catalogItemSchema = new Schema({
  title: { type: String, required: true, trim: true },
  category: { type: String, required: true, enum: ['smartphones', 'laptops', 'desktops', 'monitors', 'tablets', 'circuit_boards', 'peripherals', 'appliances', 'batteries'] },
  description: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  iconName: { type: String, default: 'phone_android' },
  basePriceMin: { type: Number, required: true },
  basePriceMax: { type: Number, required: true },
  estimatedPayoutTime: { type: String, default: 'Within 2 hours of pickup' },
  co2SavingsGrams: { type: Number, default: 25000 },
  materialsRecoverable: [{ name: String, percentageOrGrams: String }],
  bonusCampaign: {
    isActive: { type: Boolean, default: false },
    title: { type: String, default: 'Flash Recycling Bounty' },
    bonusPercentage: { type: Number, default: 20 },
    totalSlots: { type: Number, default: 50 },
    remainingSlots: { type: Number, default: 18 },
    expiresAt: { type: Date, default: null }
  },
  isActive: { type: Boolean, default: true }
}, { timestamps: true, collection: 'catalogitems' });

const sellOrderSchema = new Schema({
  orderNumber: { type: String, unique: true, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'SourceUser', required: true },
  roleType: { type: String, enum: ['individual', 'bulk_institution'], default: 'individual' },
  catalogItemId: { type: Schema.Types.ObjectId, ref: 'CatalogItem', default: null },
  itemTitle: { type: String, required: true },
  category: { type: String, required: true },
  deviceImage: { type: String, default: '' },
  aiDetectionMeta: {
    detectedClass: { type: String, default: 'Electronics' },
    confidence: { type: Number, default: 0.92 },
    modelSuggested: { type: String, default: '' },
    estimatedConditionScore: { type: String, default: 'Good' },
    detectedComponents: [{ type: String }]
  },
  userReportedCondition: { type: String, enum: ['working', 'minor_scratches', 'screen_cracked', 'dead_scrap', 'bulk_mixed'], default: 'working' },
  brandAndModel: { type: String, default: '' },
  accessoriesIncluded: [{ type: String }],
  quantity: { type: Number, default: 1 },
  agreedEstimatedPrice: { type: Number, required: true },
  bonusAmountApplied: { type: Number, default: 0 },
  totalFinalPrice: { type: Number, required: true },
  estimatedPayoutTime: { type: String, default: 'Within 2 hours of pickup' },
  carbonPointsAwarded: { type: Number, default: 0 },
  pickupAddress: {
    street: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    contactPhone: { type: String, required: true }
  },
  pickupSlot: { date: { type: String, default: '' }, timeWindow: { type: String, default: '10:00 AM - 01:00 PM' } },
  pickup: { type: Boolean, default: false },
  pickedUpAt: { type: Date, default: null },
  verified: { type: Boolean, default: false },
  verifiedAt: { type: Date, default: null },
  verifiedBy: { type: Schema.Types.ObjectId, ref: 'SourceUser', default: null },
  paid: { type: Boolean, default: false },
  paidAt: { type: Date, default: null },
  paymentReference: { type: String, default: '' },
  status: { type: String, enum: ['submitted', 'pickup_scheduled', 'inspected_verified', 'completed_paid', 'cancelled'], default: 'submitted' },
  trackingHistory: [{ status: { type: String, required: true }, title: { type: String, required: true }, description: { type: String, default: '' }, timestamp: { type: Date, default: Date.now } }],
  legacyListingId: { type: Schema.Types.ObjectId, ref: 'Listing', default: null }
}, { timestamps: true, collection: 'sellorders' });

const carbonLedgerSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'SourceUser', unique: true, required: true },
  totalCarbonPoints: { type: Number, default: 0 },
  totalKgDiverted: { type: Number, default: 0 },
  ecoTierBadge: { type: String, enum: ['Green Novice', 'Eco Guardian', 'Planet Champion', 'Carbon Neutralizer'], default: 'Green Novice' },
  history: [{
    orderId: { type: Schema.Types.ObjectId, ref: 'SellOrder', default: null },
    gramsCo2Saved: { type: Number, required: true },
    pointsEarned: { type: Number, required: true },
    deviceDescription: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now }
  }]
}, { timestamps: true, collection: 'carbonledgers' });

export const SourceUser = mongoose.models.SourceUser ?? mongoose.model('SourceUser', sourceUserSchema);
export const CatalogItem = mongoose.models.CatalogItem ?? mongoose.model('CatalogItem', catalogItemSchema);
export const SellOrder = mongoose.models.SellOrder ?? mongoose.model('SellOrder', sellOrderSchema);
export const CarbonLedger = mongoose.models.CarbonLedger ?? mongoose.model('CarbonLedger', carbonLedgerSchema);
