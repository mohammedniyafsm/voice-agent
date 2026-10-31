export interface RoomType {
  type: "standard" | "deluxe" | "suite";
  name: string;
  pricePerNightUSD: number;
  maxGuests: number;
  totalRooms: number;
  amenities: string[];
}

export interface DayInventory {
  date: string; // YYYY-MM-DD
  standardAvailable: number;
  deluxeAvailable: number;
  suiteAvailable: number;
}

export const ROOM_CATALOG: Record<string, RoomType> = {
  standard: {
    type: "standard",
    name: "Standard Room",
    pricePerNightUSD: 99,
    maxGuests: 2,
    totalRooms: 10,
    amenities: ["Queen Bed", "High-speed Wi-Fi", "Work Desk", "Coffee Maker"],
  },
  deluxe: {
    type: "deluxe",
    name: "Deluxe King Room",
    pricePerNightUSD: 160,
    maxGuests: 3,
    totalRooms: 8,
    amenities: ["King Bed", "City View Balcony", "Smart TV", "Mini Bar", "Free Breakfast"],
  },
  suite: {
    type: "suite",
    name: "Executive Ocean Suite",
    pricePerNightUSD: 280,
    maxGuests: 5,
    totalRooms: 4,
    amenities: [
      "Separate Living Room",
      "Ocean View",
      "Jacuzzi Tub",
      "Complimentary Spa Access",
      "24/7 Butler Service",
    ],
  },
};

// Generate 7 days of realistic availability starting from today
function generate7DaysInventory(): Map<string, DayInventory> {
  const inventory = new Map<string, DayInventory>();
  const now = new Date();

  // Availability patterns over 7 days
  const sampleAvailability = [
    { standard: 3, deluxe: 2, suite: 1 }, // Day 1 (Today)
    { standard: 5, deluxe: 4, suite: 2 }, // Day 2
    { standard: 2, deluxe: 1, suite: 0 }, // Day 3 (Busy)
    { standard: 6, deluxe: 5, suite: 3 }, // Day 4
    { standard: 4, deluxe: 3, suite: 1 }, // Day 5
    { standard: 1, deluxe: 2, suite: 0 }, // Day 6 (Weekend)
    { standard: 7, deluxe: 6, suite: 4 }, // Day 7
  ];

  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const avail = sampleAvailability[i % sampleAvailability.length];

    inventory.set(dateStr, {
      date: dateStr,
      standardAvailable: avail.standard,
      deluxeAvailable: avail.deluxe,
      suiteAvailable: avail.suite,
    });
  }

  return inventory;
}

const dbInventory = generate7DaysInventory();

/**
 * Tool function: Check room availability and details for specific date and number of guests.
 */
export function checkRoomAvailability(args: {
  date?: string;
  numberOfGuests?: number;
  roomType?: string;
}) {
  const targetDate = args.date ?? new Date().toISOString().slice(0, 10);
  const guests = args.numberOfGuests ?? 2;
  const requestedType = args.roomType?.toLowerCase();

  const dayData = dbInventory.get(targetDate);
  if (!dayData) {
    const availableDates = Array.from(dbInventory.keys());
    return {
      status: "date_out_of_range",
      message: `We only have booking schedules loaded from ${availableDates[0]} to ${availableDates[availableDates.length - 1]}.`,
      availableDates,
    };
  }

  const results = Object.values(ROOM_CATALOG)
    .filter((room) => {
      if (requestedType && !room.type.includes(requestedType) && !room.name.toLowerCase().includes(requestedType)) {
        return false;
      }
      return room.maxGuests >= guests;
    })
    .map((room) => {
      let availableCount = 0;
      if (room.type === "standard") availableCount = dayData.standardAvailable;
      if (room.type === "deluxe") availableCount = dayData.deluxeAvailable;
      if (room.type === "suite") availableCount = dayData.suiteAvailable;

      return {
        roomName: room.name,
        pricePerNightUSD: room.pricePerNightUSD,
        maxGuests: room.maxGuests,
        availableRoomsOnDate: availableCount,
        hasAvailability: availableCount > 0,
        amenities: room.amenities,
      };
    });

  return {
    status: "success",
    targetDate,
    requestedGuests: guests,
    availableOptions: results,
  };
}

/**
 * Tool function: Get general information about room types and max members allowed.
 */
export function getRoomCatalogDetails() {
  return {
    status: "success",
    rooms: Object.values(ROOM_CATALOG).map((r) => ({
      roomName: r.name,
      pricePerNightUSD: r.pricePerNightUSD,
      maxGuestsAllowed: r.maxGuests,
      amenities: r.amenities,
    })),
  };
}

