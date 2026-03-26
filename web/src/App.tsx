import { useEffect, useState } from "react";
import { collection, getDocs, doc, updateDoc } from "firebase/firestore";
import { db } from "./firebase";

type Status = "review" | "approved" | "rejected";

interface Player {
  id: string;
  name: string;
  position: string;
  phone: string;
  referredBy: string | null;
  city: string;
  status: Status;
  appliedAt: { seconds: number } | null;
  discordUsername: string;
}

const TABS: { label: string; value: Status }[] = [
  { label: "Review", value: "review" },
  { label: "Approved", value: "approved" },
  { label: "Rejected", value: "rejected" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Status>("review");
  const [players, setPlayers] = useState<Record<Status, Player[]>>({
    review: [],
    approved: [],
    rejected: [],
  });
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [cityFilter, setCityFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  async function fetchPlayers() {
    setLoading(true);
    const snapshot = await getDocs(collection(db, "players"));
    const grouped: Record<Status, Player[]> = { review: [], approved: [], rejected: [] };
    snapshot.docs.forEach((d) => {
      const p = { id: d.id, ...d.data() } as Player;
      if (p.status in grouped) grouped[p.status].push(p);
    });
    setPlayers(grouped);
    setLoading(false);
  }

  async function updateStatus(id: string, newStatus: "approved" | "rejected") {
    setUpdating(id);
    await updateDoc(doc(db, "players", id), { status: newStatus });
    setPlayers((prev) => {
      const player = prev.review.find((p) => p.id === id)!;
      return {
        ...prev,
        review: prev.review.filter((p) => p.id !== id),
        [newStatus]: [...prev[newStatus], { ...player, status: newStatus }],
      };
    });
    setUpdating(null);
  }

  useEffect(() => { fetchPlayers(); }, []);

  const CITIES = ["Dallas", "Houston", "Seattle"];
  const current = players[activeTab].filter((p) =>
    (cityFilter === "all" || p.city === cityFilter) &&
    (search === "" || p.name.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-6xl mx-auto px-6 py-10">

        <h1 className="text-2xl font-bold text-gray-900 mb-8">
          Ramadan Hoops — Applications
        </h1>

        {/* Tabs + Filter */}
        <div className="flex items-end justify-between border-b border-gray-200 mb-6">
          <div className="flex gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer ${
                  activeTab === tab.value
                    ? "border-gray-900 text-gray-900"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {tab.label}
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  activeTab === tab.value
                    ? "bg-gray-900 text-white"
                    : "bg-gray-200 text-gray-600"
                }`}>
                  {players[tab.value].length}
                </span>
              </button>
            ))}
          </div>

          {!loading && (
            <div className="flex items-center gap-2 pb-3">
              <label className="text-sm text-gray-500">City</label>
              <select
                value={cityFilter}
                onChange={(e) => setCityFilter(e.target.value)}
                className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 cursor-pointer"
              >
                <option value="all">All Cities</option>
                {CITIES.map((city) => (
                  <option key={city} value={city}>{city}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Search */}
        {!loading && (
          <div className="mb-5">
            <input
              type="text"
              placeholder="Search by name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 w-64 focus:outline-none focus:ring-2 focus:ring-gray-300"
            />
          </div>
        )}

        {/* Content */}
        {loading && (
          <p className="text-gray-500 mt-4">Loading...</p>
        )}

        {!loading && current.length === 0 && (
          <p className="text-gray-500 mt-4">
            No {activeTab} applications{cityFilter !== "all" ? ` in ${cityFilter}` : ""}.
          </p>
        )}

        {!loading && current.length > 0 && (
          <div className="flex flex-col gap-3">
            {current.map((p) => (
              <div key={p.id} className="bg-white rounded-xl shadow-sm px-5 py-4 flex items-center gap-6">

                {/* Name + Discord */}
                <div className="w-48 shrink-0">
                  <p className="text-sm font-semibold text-gray-900">{p.name}</p>
                  <p className="text-xs text-gray-400">{p.discordUsername}</p>
                </div>

                {/* Fields */}
                <div className="flex items-center gap-6 flex-1 text-sm text-gray-600">
                  <div className="w-16">
                    <p className="text-xs text-gray-400 mb-0.5">Position</p>
                    <p className="font-medium text-gray-800">{p.position}</p>
                  </div>
                  <div className="w-24">
                    <p className="text-xs text-gray-400 mb-0.5">City</p>
                    <p className="font-medium text-gray-800">{p.city}</p>
                  </div>
                  <div className="w-32">
                    <p className="text-xs text-gray-400 mb-0.5">Phone</p>
                    <p className="font-medium text-gray-800">{p.phone}</p>
                  </div>
                  <div className="w-32">
                    <p className="text-xs text-gray-400 mb-0.5">Referred By</p>
                    <p className="font-medium text-gray-800">{p.referredBy || "—"}</p>
                  </div>
                  <div className="w-24">
                    <p className="text-xs text-gray-400 mb-0.5">Applied</p>
                    <p className="font-medium text-gray-800">
                      {p.appliedAt
                        ? new Date(p.appliedAt.seconds * 1000).toLocaleDateString()
                        : "—"}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                {activeTab === "review" && (
                  <div className="flex gap-2 shrink-0">
                    <button
                      disabled={updating === p.id}
                      onClick={() => updateStatus(p.id, "approved")}
                      className="px-4 py-1.5 bg-green-500 hover:bg-green-600 text-white text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      disabled={updating === p.id}
                      onClick={() => updateStatus(p.id, "rejected")}
                      className="px-4 py-1.5 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
