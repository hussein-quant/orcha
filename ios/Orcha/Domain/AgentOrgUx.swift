import Foundation

/// Reporting-line tree for the Agents tab's Org view — pure, so it is unit-tested.
enum AgentOrgUx {
    struct Node: Identifiable, Equatable {
        let id: String
        let depth: Int
    }

    /// Depth-first flattening: roots (no manager, or a manager outside the set / a cycle)
    /// first in `order`, each followed by its reports, indented by `depth`.
    static func flatten(order: [String], managerOf: [String: String]) -> [Node] {
        let ids = Set(order)
        var children: [String: [String]] = [:]
        var roots: [String] = []
        for id in order {
            if let m = managerOf[id], ids.contains(m), m != id, !reachesSelf(id, managerOf) {
                children[m, default: []].append(id)
            } else {
                roots.append(id)
            }
        }
        var out: [Node] = []
        var seen = Set<String>()
        func walk(_ id: String, _ depth: Int) {
            guard seen.insert(id).inserted else { return }
            out.append(Node(id: id, depth: depth))
            for c in children[id] ?? [] { walk(c, depth + 1) }
        }
        for r in roots { walk(r, 0) }
        return out
    }

    private static func reachesSelf(_ id: String, _ managerOf: [String: String]) -> Bool {
        var cur = managerOf[id]
        var hops = 0
        while let c = cur, hops < 64 {
            if c == id { return true }
            cur = managerOf[c]
            hops += 1
        }
        return false
    }
}
