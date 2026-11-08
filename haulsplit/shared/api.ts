/** Shapes of the JSON the API returns. Shared by the worker and the web app. */
import type { Unit } from "./units";

export type HaulStatus = "draft" | "open" | "closed";

export interface Me {
  id: string;
  name: string;
  email: string | null;
  zelle: string | null;
  hasPassword: boolean;
}

export interface GroupSummary {
  id: string;
  name: string;
  memberCount: number;
  isOwner: boolean;
}

export interface HaulSummary {
  id: string;
  groupId: string;
  groupName: string;
  title: string;
  store: string | null;
  purchasedOn: string | null;
  status: HaulStatus;
  organizerId: string;
  organizerName: string;
  isOrganizer: boolean;
  itemCount: number;
  haulCents: number;
  myTotalCents: number;
  myPaidCents: number;
  myVerifiedCents: number;
  myConfirmed: boolean;
  /** For organizers: what other people still owe them. */
  outstandingCents: number;
  /** Soonest expiration among items I've claimed (or all items, for the organizer). */
  nextExpiry: string | null;
  createdAt: number;
}

export interface HomeData {
  me: Me;
  groups: GroupSummary[];
  hauls: HaulSummary[];
}

export interface Member {
  id: string;
  name: string;
  /** Has a way to log in (password or an active session). */
  canLogIn: boolean;
  hasPassword: boolean;
  isOwner: boolean;
}

export interface GroupDetail {
  group: { id: string; name: string; inviteCode: string; ownerId: string };
  members: Member[];
  hauls: HaulSummary[];
}

export interface Claim {
  userId: string;
  shares: number;
}

export interface Item {
  id: string;
  name: string;
  itemNumber: string | null;
  barcode: string | null;
  priceCents: number;
  quantity: number;
  unit: Unit;
  shares: number;
  taxable: boolean;
  expiresOn: string | null;
  notes: string | null;
  position: number;
  claims: Claim[];
}

export interface Settlement {
  userId: string;
  confirmedAt: number | null;
  paidCents: number;
  paidAt: number | null;
  verifiedCents: number;
  verifiedAt: number | null;
}

export interface HaulDetail {
  haul: {
    id: string;
    groupId: string;
    groupName: string;
    title: string;
    store: string | null;
    purchasedOn: string | null;
    pickup: string | null;
    taxRate: number;
    status: HaulStatus;
    organizer: { id: string; name: string; zelle: string | null };
    createdAt: number;
    updatedAt: number;
  };
  meId: string;
  isOrganizer: boolean;
  members: { id: string; name: string }[];
  items: Item[];
  settlements: Settlement[];
}

export interface ItemInput {
  name: string;
  itemNumber?: string | null;
  barcode?: string | null;
  priceCents: number;
  quantity: number;
  unit: Unit;
  shares: number;
  taxable: boolean;
  expiresOn?: string | null;
  notes?: string | null;
}

export interface ReceiptItem {
  name: string;
  rawName: string;
  itemNumber: string | null;
  priceCents: number;
  discountCents: number;
  taxable: boolean;
  quantity: number;
  unit: Unit;
  shares: number;
}

export interface ReceiptResult {
  source: "ai" | "text";
  items: ReceiptItem[];
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  purchaseDate: string | null;
  warnings: string[];
}

export interface ProductLookup {
  code: string;
  source: "group" | "openfoodfacts" | "upcitemdb" | null;
  product: {
    name: string;
    quantity: number | null;
    unit: Unit | null;
    shares: number | null;
    priceCents: number | null;
    taxable: boolean | null;
  } | null;
}
