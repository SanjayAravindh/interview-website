# Senior Java Developer — Coding Interview Reference

> Practical patterns for senior-level interviews. Not academic proofs — focus on recognition, implementation, trade-offs, and production analogies.

---

## Table of Contents

1. [Complexity Basics (Big-O)](#1-complexity-basics-big-o)
2. [How to Approach Interview Problems](#2-how-to-approach-interview-problems)
3. [Hash Map / Set Tricks](#3-hash-map--set-tricks)
4. [Two Pointers & Sliding Window](#4-two-pointers--sliding-window)
5. [Binary Search Variants](#5-binary-search-variants)
6. [Sorting — When to Use What](#6-sorting--when-to-use-what)
7. [Stack / Queue / Deque Patterns](#7-stack--queue--deque-patterns)
8. [Tree Traversals & BST Operations](#8-tree-traversals--bst-operations)
9. [Graph BFS/DFS & Shortest Path](#9-graph-bfsdfs--shortest-path)
10. [Heap / Priority Queue (Top K)](#10-heap--priority-queue-top-k)
11. [Union-Find (Disjoint Set)](#11-union-find-disjoint-set)
12. [Dynamic Programming](#12-dynamic-programming)
13. [Backtracking](#13-backtracking)
14. [Trie](#14-trie)
15. [LRU Cache](#15-lru-cache)
16. [Concurrency-Safe Structures (Brief)](#16-concurrency-safe-structures-brief)
17. [Scenario Q&A — Patterns Meet System Design](#17-scenario-qa--patterns-meet-system-design)
18. [Quick Reference Cheat Sheet](#18-quick-reference-cheat-sheet)

---

## 1. Complexity Basics (Big-O)

### What Big-O Actually Means

Big-O describes **upper-bound growth rate** as input size `n` → ∞. It ignores constants and lower-order terms.

| Notation | Meaning | Interview usage |
|----------|---------|-----------------|
| O(1) | Constant | Hash map lookup, array index |
| O(log n) | Logarithmic | Binary search, balanced BST ops |
| O(n) | Linear | Single pass, hash map build |
| O(n log n) | Linearithmic | Efficient sorting |
| O(n²) | Quadratic | Nested loops, naive DP |
| O(2ⁿ) | Exponential | Subset generation without memo |
| O(n!) | Factorial | Permutation enumeration |

### Common Operation Costs (Java Collections)

```
ArrayList:
  get/set by index     O(1)
  add at end           O(1) amortized
  add/remove at front  O(n)
  contains             O(n)

HashMap / HashSet:
  get/put/remove       O(1) average, O(n) worst (hash collisions)
  iteration            O(n)

TreeMap / TreeSet:
  get/put/remove       O(log n)
  ordered traversal    O(n)

PriorityQueue:
  offer/poll           O(log n)
  peek                 O(1)

LinkedList (as Deque):
  add/remove ends      O(1)
  get by index         O(n)
```

### Amortized Analysis — Why It Matters

`ArrayList.add()` is O(1) **amortized** because occasional resize copies all elements. In interviews, say "amortized O(1)" when appending to dynamic arrays.

`HashMap` rehashing is amortized O(1) per insert under uniform hashing assumption.

### Space Complexity

Always account for:
- **Input space** (usually not counted toward "extra" space)
- **Auxiliary space** (recursion stack, hash maps, queues)
- **Output space** (if problem asks to return a large structure)

Recursion depth = O(h) where h is tree height or call-stack depth.

### Senior-Level Trade-off Questions

Interviewers expect you to articulate:

> "I can trade O(n) extra space for O(n) time instead of O(n²) by using a HashMap."

> "We could sort first — O(n log n) — then two-pointer in O(n), total O(n log n)."

> "BFS uses O(V) queue space; DFS recursion is O(h) where h may be O(V) in worst case."

---

## 2. How to Approach Interview Problems

### The CLARIFY → PLAN → CODE → TEST Framework

#### Step 1: CLARIFY (2–3 minutes)

Ask about:
- Input size and constraints (`n ≤ 10⁵` → need O(n log n) or better)
- Edge cases: empty, single element, duplicates, negative numbers, overflow
- Return type: index vs value, all solutions vs one, sorted order
- Mutability: in-place allowed?
- Data types: `int` overflow → use `long`

**Example questions:**
- "Can the array be empty?"
- "Are elements guaranteed unique?"
- "Should I optimize for time or memory?"

#### Step 2: PLAN (3–5 minutes)

1. State brute force and its complexity
2. Identify pattern (hash map? sliding window? DP?)
3. Walk through a small example on the whiteboard
4. State final time/space complexity **before** coding

#### Step 3: CODE (15–20 minutes)

- Use meaningful names (`left`, `right`, `freqMap`, not `i`, `j`, `m`)
- Extract helper methods for clarity
- Handle edge cases at the top
- Prefer iterative over recursive when stack depth is risky

#### Step 4: TEST (3–5 minutes)

Test mentally:
- Empty input
- Single element
- Two elements
- Duplicates
- Large values / overflow
- Your own example from planning step

### Pattern Recognition Signals

| You see... | Think... |
|------------|----------|
| "Find pair/triplet with sum X" | Hash map or two pointers (if sorted) |
| "Longest/shortest subarray/substring with property" | Sliding window |
| "Sorted array, find target" | Binary search |
| "Top K largest/smallest" | Min/max heap of size K |
| "Connected components, cycles" | Union-Find or DFS |
| "All combinations/permutations" | Backtracking |
| "Count ways / min cost / max profit" | DP |
| "Prefix matching, autocomplete" | Trie |
| "Evict least recently used" | LRU cache (LinkedHashMap or custom) |
| "Monotonic property in sequence" | Stack or monotonic deque |

### Communication Tips for Senior Roles

- Narrate trade-offs: "HashMap gives O(1) lookup but uses O(n) memory"
- Mention production context: "This is how Redis tracks key frequency with a similar sliding window"
- Acknowledge alternatives: "We could also solve with a Trie if prefix queries dominate"
- Discuss testability: "I'd extract the window logic into a package-private method for unit tests"

---

## 3. Hash Map / Set Tricks

### When to Use

- **O(1) lookup** for "have we seen this value?"
- **Frequency counting** (anagrams, majority element)
- **Index mapping** (value → index for Two Sum)
- **Grouping** by computed key (anagram signature)
- **Deduplication** with HashSet

### Template: Frequency Map

```java
Map<Character, Integer> freq = new HashMap<>();
for (char c : s.toCharArray()) {
    freq.merge(c, 1, Integer::sum);
}
```

### Template: Complement Lookup (Two Sum Pattern)

```java
public int[] twoSum(int[] nums, int target) {
    Map<Integer, Integer> indexByValue = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
        int complement = target - nums[i];
        if (indexByValue.containsKey(complement)) {
            return new int[]{indexByValue.get(complement), i};
        }
        indexByValue.put(nums[i], i);
    }
    throw new IllegalArgumentException("No solution");
}
// Time: O(n), Space: O(n)
```

### Template: Group By Key

```java
Map<String, List<String>> groups = new HashMap<>();
for (String word : words) {
    char[] chars = word.toCharArray();
    Arrays.sort(chars);
    String key = new String(chars);
    groups.computeIfAbsent(key, k -> new ArrayList<>()).add(word);
}
```

### Problem 1: Two Sum (LC 1)

**Statement:** Return indices of two numbers that add to `target`.

```java
public int[] twoSum(int[] nums, int target) {
    Map<Integer, Integer> seen = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
        int need = target - nums[i];
        if (seen.containsKey(need)) {
            return new int[]{seen.get(need), i};
        }
        seen.put(nums[i], i);
    }
    return new int[]{};
}
```

| Time | Space |
|------|-------|
| O(n) | O(n) |

**Production analogy:** Indexing foreign keys in ORM — map ID → entity for O(1) join resolution in memory.

### Problem 2: Group Anagrams (LC 49)

```java
public List<List<String>> groupAnagrams(String[] strs) {
    Map<String, List<String>> map = new HashMap<>();
    for (String s : strs) {
        int[] count = new int[26];
        for (char c : s.toCharArray()) {
            count[c - 'a']++;
        }
        String key = Arrays.toString(count); // or encode count as string
        map.computeIfAbsent(key, k -> new ArrayList<>()).add(s);
    }
    return new ArrayList<>(map.values());
}
```

| Time | Space |
|------|-------|
| O(n · k) where k = max string length | O(n · k) |

**Production analogy:** Log aggregation — bucket events by normalized signature (e.g., strip variable IDs).

### Problem 3: Longest Consecutive Sequence (LC 128)

**Key insight:** Only start counting from sequence **starts** (no `num-1` in set).

```java
public int longestConsecutive(int[] nums) {
    Set<Integer> set = new HashSet<>();
    for (int n : nums) set.add(n);

    int best = 0;
    for (int n : set) {
        if (!set.contains(n - 1)) { // sequence start
            int len = 1;
            while (set.contains(n + len)) len++;
            best = Math.max(best, len);
        }
    }
    return best;
}
```

| Time | Space |
|------|-------|
| O(n) — each element visited at most twice | O(n) |

**Production analogy:** Detecting contiguous session IDs or sequence gaps in audit logs.

### Hash Map Gotchas in Java

```java
// Use merge for counting — cleaner than get/put
map.merge(key, 1, Integer::sum);

// computeIfAbsent avoids null checks
map.computeIfAbsent(key, k -> new ArrayList<>()).add(value);

// IdentityHashMap — reference equality (rare, serialization graphs)
// LinkedHashMap — insertion or access order (LRU building block)
// EnumMap — O(1) for enum keys, compact array backing
```

---

## 4. Two Pointers & Sliding Window

### Two Pointers — When to Use

- **Sorted array** — pair sum, remove duplicates, merge
- **Two sequences** — merge sorted arrays, compare strings
- **Partitioning** — Dutch flag, quickselect partition
- **Palindrome** — inward pointers from both ends

### Template: Opposite Ends (Sorted Array)

```java
public int[] twoSumSorted(int[] nums, int target) {
    int left = 0, right = nums.length - 1;
    while (left < right) {
        int sum = nums[left] + nums[right];
        if (sum == target) return new int[]{left + 1, right + 1};
        else if (sum < target) left++;
        else right--;
    }
    return new int[]{};
}
// Time: O(n), Space: O(1) — requires sorted input
```

### Template: Fast/Slow (Linked List Cycle, Remove Duplicates)

```java
public ListNode removeDuplicates(ListNode head) {
    if (head == null) return null;
    ListNode slow = head;
    ListNode fast = head.next;
    while (fast != null) {
        if (slow.val != fast.val) {
            slow.next = fast;
            slow = slow.next;
        }
        fast = fast.next;
    }
    slow.next = null;
    return head;
}
```

### Sliding Window — When to Use

- **Contiguous subarray/substring** optimization
- Keywords: "longest", "shortest", "maximum/minimum in window"
- Fixed-size window OR variable-size with expand/shrink

### Template: Variable Sliding Window

```java
public int lengthOfLongestSubstring(String s) {
    Map<Character, Integer> lastSeen = new HashMap<>();
    int left = 0, best = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        if (lastSeen.containsKey(c) && lastSeen.get(c) >= left) {
            left = lastSeen.get(c) + 1;
        }
        lastSeen.put(c, right);
        best = Math.max(best, right - left + 1);
    }
    return best;
}
// Time: O(n), Space: O(min(n, alphabet))
```

### Template: Fixed Window Size K

```java
public int maxSumSubarrayOfSizeK(int[] nums, int k) {
    int windowSum = 0;
    for (int i = 0; i < k; i++) windowSum += nums[i];
    int best = windowSum;
    for (int right = k; right < nums.length; right++) {
        windowSum += nums[right] - nums[right - k];
        best = Math.max(best, windowSum);
    }
    return best;
}
// Time: O(n), Space: O(1)
```

### Problem 1: Container With Most Water (LC 11)

```java
public int maxArea(int[] height) {
    int left = 0, right = height.length - 1, best = 0;
    while (left < right) {
        int h = Math.min(height[left], height[right]);
        best = Math.max(best, h * (right - left));
        if (height[left] < height[right]) left++;
        else right--;
    }
    return best;
}
```

| Time | Space |
|------|-------|
| O(n) | O(1) |

**Production analogy:** Load balancer pairing endpoints — move the shorter side to find better throughput pairing.

### Problem 2: Minimum Window Substring (LC 76)

```java
public String minWindow(String s, String t) {
    if (t.isEmpty()) return "";

    int[] need = new int[128];
    for (char c : t.toCharArray()) need[c]++;

    int required = t.length();
    int formed = 0;
    int[] window = new int[128];

    int left = 0, start = 0, len = Integer.MAX_VALUE;

    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        window[c]++;
        if (need[c] > 0 && window[c] <= need[c]) formed++;

        while (formed == required) {
            if (right - left + 1 < len) {
                len = right - left + 1;
                start = left;
            }
            char leftChar = s.charAt(left);
            if (need[leftChar] > 0 && window[leftChar] == need[leftChar]) formed--;
            window[leftChar]--;
            left++;
        }
    }
    return len == Integer.MAX_VALUE ? "" : s.substring(start, start + len);
}
```

| Time | Space |
|------|-------|
| O(\|s\| + \|t\|) | O(128) = O(1) for ASCII |

**Production analogy:** Finding smallest log window containing all required trace IDs.

### Problem 3: Subarray Sum Equals K (LC 560)

**Pattern:** Prefix sum + hash map (not pure sliding window — handles negatives).

```java
public int subarraySum(int[] nums, int k) {
    Map<Integer, Integer> prefixCount = new HashMap<>();
    prefixCount.put(0, 1);
    int sum = 0, count = 0;
    for (int n : nums) {
        sum += n;
        count += prefixCount.getOrDefault(sum - k, 0);
        prefixCount.merge(sum, 1, Integer::sum);
    }
    return count;
}
```

| Time | Space |
|------|-------|
| O(n) | O(n) |

**Production analogy:** Rolling billing windows — count intervals where cumulative usage hits a threshold.

---

## 5. Binary Search Variants

### When to Use

- Sorted array or **monotonic answer space**
- O(log n) required on large n (10⁹)
- "Find first/last position", "minimize maximum", "maximize minimum"

### Template: Classic Binary Search

```java
public int binarySearch(int[] nums, int target) {
    int lo = 0, hi = nums.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2; // avoid overflow
        if (nums[mid] == target) return mid;
        else if (nums[mid] < target) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}
```

### Template: Lower Bound (First >= target)

```java
public int lowerBound(int[] nums, int target) {
    int lo = 0, hi = nums.length; // half-open [lo, hi)
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
```

### Template: Binary Search on Answer

```java
// Example: minimum capacity to ship packages in D days
public int shipWithinDays(int[] weights, int days) {
    int lo = Arrays.stream(weights).max().getAsInt();
    int hi = Arrays.stream(weights).sum();
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (canShip(weights, days, mid)) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

private boolean canShip(int[] weights, int days, int capacity) {
    int d = 1, load = 0;
    for (int w : weights) {
        if (load + w > capacity) { d++; load = 0; }
        load += w;
    }
    return d <= days;
}
```

### Problem 1: Search in Rotated Sorted Array (LC 33)

```java
public int search(int[] nums, int target) {
    int lo = 0, hi = nums.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] == target) return mid;

        if (nums[lo] <= nums[mid]) { // left half sorted
            if (nums[lo] <= target && target < nums[mid]) hi = mid - 1;
            else lo = mid + 1;
        } else { // right half sorted
            if (nums[mid] < target && target <= nums[hi]) lo = mid + 1;
            else hi = mid - 1;
        }
    }
    return -1;
}
```

| Time | Space |
|------|-------|
| O(log n) | O(1) |

### Problem 2: Find Minimum in Rotated Sorted Array (LC 153)

```java
public int findMin(int[] nums) {
    int lo = 0, hi = nums.length - 1;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] > nums[hi]) lo = mid + 1;
        else hi = mid;
    }
    return nums[lo];
}
```

### Problem 3: Koko Eating Bananas (LC 875) — Binary Search on Answer

```java
public int minEatingSpeed(int[] piles, int h) {
    int lo = 1, hi = Arrays.stream(piles).max().getAsInt();
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (hoursNeeded(piles, mid) <= h) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

private long hoursNeeded(int[] piles, int speed) {
    long hours = 0;
    for (int p : piles) hours += (p + speed - 1) / speed; // ceil division
    return hours;
}
```

| Time | Space |
|------|-------|
| O(n log m) where m = max pile | O(1) |

**Production analogy:** Auto-scaling — binary search for minimum instance count meeting SLA.

---

## 6. Sorting — When to Use What

### Algorithm Comparison

| Algorithm | Time (avg) | Time (worst) | Space | Stable | When |
|-----------|------------|--------------|-------|--------|------|
| `Arrays.sort(int[])` | O(n log n) | O(n log n) | O(log n) stack | No | Primitives |
| `Arrays.sort(Object[])` | O(n log n) | O(n log n) | O(log n) | Yes | Objects (TimSort) |
| `Collections.sort` | O(n log n) | O(n log n) | O(log n) | Yes | Lists |
| Counting sort | O(n + k) | O(n + k) | O(k) | Yes | Small integer range |
| Bucket sort | O(n) avg | O(n²) | O(n) | Yes | Uniform distribution |

### Java Sorting Patterns

```java
// Custom comparator — sort intervals by end time
Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));

// Sort by multiple keys
Arrays.sort(people, (a, b) -> {
    if (a[0] != b[0]) return Integer.compare(b[0], a[0]); // height desc
    return Integer.compare(a[1], b[1]);                   // name asc (lex)
});

// PriorityQueue is NOT full sort — O(n log k) for top K
```

### When Sorting Helps

1. **Enable two pointers** — pair sum after sort
2. **Greedy scheduling** — sort by deadline or end time
3. **Binary search** — prerequisite
4. **Merge intervals** — sort by start
5. **Eliminate ordering uncertainty** — process in deterministic order

### Problem 1: Merge Intervals (LC 56)

```java
public int[][] merge(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));
    List<int[]> merged = new ArrayList<>();
    for (int[] interval : intervals) {
        if (merged.isEmpty() || merged.get(merged.size() - 1)[1] < interval[0]) {
            merged.add(interval);
        } else {
            merged.get(merged.size() - 1)[1] =
                Math.max(merged.get(merged.size() - 1)[1], interval[1]);
        }
    }
    return merged.toArray(new int[0][]);
}
```

| Time | Space |
|------|-------|
| O(n log n) | O(n) |

**Production analogy:** Merging overlapping maintenance windows in a calendar service.

### Problem 2: Meeting Rooms II (LC 253)

```java
public int minMeetingRooms(int[][] intervals) {
    if (intervals.length == 0) return 0;
    int n = intervals.length;
    int[] starts = new int[n], ends = new int[n];
    for (int i = 0; i < n; i++) {
        starts[i] = intervals[i][0];
        ends[i] = intervals[i][1];
    }
    Arrays.sort(starts);
    Arrays.sort(ends);

    int rooms = 0, endPtr = 0;
    for (int i = 0; i < n; i++) {
        if (starts[i] < ends[endPtr]) rooms++;
        else endPtr++;
    }
    return rooms;
}
```

| Time | Space |
|------|-------|
| O(n log n) | O(n) |

**Production analogy:** Connection pool sizing — peak concurrent DB sessions.

### Problem 3: Largest Number (LC 179) — Custom Sort

```java
public String largestNumber(int[] nums) {
    String[] strs = new String[nums.length];
    for (int i = 0; i < nums.length; i++) strs[i] = String.valueOf(nums[i]);
    Arrays.sort(strs, (a, b) -> (b + a).compareTo(a + b));
    if (strs[0].equals("0")) return "0";
    return String.join("", strs);
}
```

**Production analogy:** Version string ordering (`"10.2"` vs `"10.10"`) — custom comparators in release pipelines.

---

## 7. Stack / Queue / Deque Patterns

### Stack — When to Use

- **Matching brackets / tags** (HTML, JSON validation)
- **Monotonic stack** — next greater element, histogram area
- **DFS iterative** (alternative to recursion)
- **Expression evaluation** (RPN, calculator)
- **Undo operations**

### Queue — When to Use

- **BFS** level-order traversal
- **Task scheduling** (FIFO fairness)
- **Buffering** between producer/consumer

### Deque — When to Use

- **Sliding window max/min** (monotonic deque)
- **BFS** (can add to both ends)
- **Palindrome checking** from both ends

### Template: Monotonic Stack (Next Greater Element)

```java
public int[] nextGreaterElement(int[] nums) {
    int n = nums.length;
    int[] result = new int[n];
    Arrays.fill(result, -1);
    Deque<Integer> stack = new ArrayDeque<>(); // indices, decreasing values

    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] < nums[i]) {
            result[stack.pop()] = nums[i];
        }
        stack.push(i);
    }
    return result;
}
// Time: O(n), Space: O(n)
```

### Template: Valid Parentheses

```java
public boolean isValid(String s) {
    Deque<Character> stack = new ArrayDeque<>();
    Map<Character, Character> pairs = Map.of(')', '(', '}', '{', ']', '[');
    for (char c : s.toCharArray()) {
        if (pairs.containsValue(c)) {
            stack.push(c);
        } else {
            if (stack.isEmpty() || stack.pop() != pairs.get(c)) return false;
        }
    }
    return stack.isEmpty();
}
```

### Template: Monotonic Deque — Sliding Window Maximum (LC 239)

```java
public int[] maxSlidingWindow(int[] nums, int k) {
    Deque<Integer> deque = new ArrayDeque<>(); // indices, decreasing values
    int[] result = new int[nums.length - k + 1];

    for (int i = 0; i < nums.length; i++) {
        while (!deque.isEmpty() && deque.peekFirst() < i - k + 1) {
            deque.pollFirst();
        }
        while (!deque.isEmpty() && nums[deque.peekLast()] <= nums[i]) {
            deque.pollLast();
        }
        deque.offerLast(i);
        if (i >= k - 1) result[i - k + 1] = nums[deque.peekFirst()];
    }
    return result;
}
```

| Time | Space |
|------|-------|
| O(n) — each element pushed/popped once | O(k) |

### Problem 1: Daily Temperatures (LC 739)

```java
public int[] dailyTemperatures(int[] temperatures) {
    int n = temperatures.length;
    int[] answer = new int[n];
    Deque<Integer> stack = new ArrayDeque<>();
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && temperatures[i] > temperatures[stack.peek()]) {
            int prev = stack.pop();
            answer[prev] = i - prev;
        }
        stack.push(i);
    }
    return answer;
}
```

### Problem 2: Largest Rectangle in Histogram (LC 84)

```java
public int largestRectangleArea(int[] heights) {
    Deque<Integer> stack = new ArrayDeque<>();
    int best = 0;
    for (int i = 0; i <= heights.length; i++) {
        int h = (i == heights.length) ? 0 : heights[i];
        while (!stack.isEmpty() && h < heights[stack.peek()]) {
            int height = heights[stack.pop()];
            int width = stack.isEmpty() ? i : i - stack.peek() - 1;
            best = Math.max(best, height * width);
        }
        stack.push(i);
    }
    return best;
}
```

| Time | Space |
|------|-------|
| O(n) | O(n) |

**Production analogy:** Capacity planning — find widest contiguous time window at a given load level.

### Problem 3: Evaluate Reverse Polish Notation (LC 150)

```java
public int evalRPN(String[] tokens) {
    Deque<Integer> stack = new ArrayDeque<>();
    for (String t : tokens) {
        switch (t) {
            case "+" -> stack.push(stack.pop() + stack.pop());
            case "-" -> { int b = stack.pop(); stack.push(stack.pop() - b); }
            case "*" -> stack.push(stack.pop() * stack.pop());
            case "/" -> { int b = stack.pop(); stack.push(stack.pop() / b); }
            default -> stack.push(Integer.parseInt(t));
        }
    }
    return stack.pop();
}
```

**Production analogy:** Rule engine evaluation stacks in Drools / custom DSL interpreters.

---

## 8. Tree Traversals & BST Operations

### Tree Node Definition

```java
class TreeNode {
    int val;
    TreeNode left, right;
    TreeNode(int val) { this.val = val; }
}
```

### Traversal Comparison

| Order | Sequence | Use case |
|-------|----------|----------|
| Inorder (LNR) | Left, Node, Right | BST → sorted order |
| Preorder (NLR) | Node, Left, Right | Serialize tree, copy |
| Postorder (LRN) | Left, Right, Node | Delete tree, evaluate expr |
| Level-order (BFS) | Level by level | Shortest path in tree, zigzag |

### Template: BFS (Level Order)

```java
public List<List<Integer>> levelOrder(TreeNode root) {
    List<List<Integer>> result = new ArrayList<>();
    if (root == null) return result;

    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);

    while (!queue.isEmpty()) {
        int size = queue.size();
        List<Integer> level = new ArrayList<>();
        for (int i = 0; i < size; i++) {
            TreeNode node = queue.poll();
            level.add(node.val);
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        result.add(level);
    }
    return result;
}
// Time: O(n), Space: O(w) where w = max width
```

### Template: DFS — Recursive

```java
public void inorder(TreeNode node, List<Integer> result) {
    if (node == null) return;
    inorder(node.left, result);
    result.add(node.val);
    inorder(node.right, result);
}
```

### Template: DFS — Iterative with Stack

```java
public List<Integer> inorderIterative(TreeNode root) {
    List<Integer> result = new ArrayList<>();
    Deque<TreeNode> stack = new ArrayDeque<>();
    TreeNode curr = root;
    while (curr != null || !stack.isEmpty()) {
        while (curr != null) {
            stack.push(curr);
            curr = curr.left;
        }
        curr = stack.pop();
        result.add(curr.val);
        curr = curr.right;
    }
    return result;
}
```

### BST Operations

```java
// Search — O(h) where h = height, O(log n) balanced
public TreeNode searchBST(TreeNode root, int val) {
    while (root != null && root.val != val) {
        root = val < root.val ? root.left : root.right;
    }
    return root;
}

// Insert — O(h)
public TreeNode insertIntoBST(TreeNode root, int val) {
    if (root == null) return new TreeNode(val);
    if (val < root.val) root.left = insertIntoBST(root.left, val);
    else root.right = insertIntoBST(root.right, val);
    return root;
}
```

### Problem 1: Validate BST (LC 98)

```java
public boolean isValidBST(TreeNode root) {
    return validate(root, null, null);
}

private boolean validate(TreeNode node, Integer min, Integer max) {
    if (node == null) return true;
    if (min != null && node.val <= min) return false;
    if (max != null && node.val >= max) return false;
    return validate(node.left, min, node.val)
        && validate(node.right, node.val, max);
}
```

| Time | Space |
|------|-------|
| O(n) | O(h) recursion |

### Problem 2: Lowest Common Ancestor of BST (LC 235)

```java
public TreeNode lowestCommonAncestor(TreeNode root, TreeNode p, TreeNode q) {
    while (root != null) {
        if (p.val < root.val && q.val < root.val) root = root.left;
        else if (p.val > root.val && q.val > root.val) root = root.right;
        else return root;
    }
    return null;
}
```

| Time | Space |
|------|-------|
| O(h) | O(1) |

**Production analogy:** Organizational hierarchy — find lowest manager overseeing two employees.

### Problem 3: Binary Tree Maximum Path Sum (LC 124)

```java
public int maxPathSum(TreeNode root) {
    int[] max = {Integer.MIN_VALUE};
    maxGain(root, max);
    return max[0];
}

private int maxGain(TreeNode node, int[] max) {
    if (node == null) return 0;
    int left = Math.max(maxGain(node.left, max), 0);
    int right = Math.max(maxGain(node.right, max), 0);
    max[0] = Math.max(max[0], node.val + left + right);
    return node.val + Math.max(left, right);
}
```

| Time | Space |
|------|-------|
| O(n) | O(h) |

**Production analogy:** Max throughput path in a dependency tree (critical path with positive/negative weights).

---

## 9. Graph BFS/DFS & Shortest Path

### Graph Representations

```java
// Adjacency list — preferred for sparse graphs
Map<Integer, List<Integer>> graph = new HashMap<>();
void addEdge(int u, int v) {
    graph.computeIfAbsent(u, k -> new ArrayList<>()).add(v);
    graph.computeIfAbsent(v, k -> new ArrayList<>()).add(u); // undirected
}

// 2D grid as implicit graph — neighbors: up, down, left, right
int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
```

### Template: BFS — Shortest Path (Unweighted)

```java
public int shortestPath(Map<Integer, List<Integer>> graph, int start, int end) {
    if (start == end) return 0;
    Queue<Integer> queue = new ArrayDeque<>();
    Set<Integer> visited = new HashSet<>();
    queue.offer(start);
    visited.add(start);
    int dist = 0;

    while (!queue.isEmpty()) {
        int size = queue.size();
        dist++;
        for (int i = 0; i < size; i++) {
            int node = queue.poll();
            for (int neighbor : graph.getOrDefault(node, List.of())) {
                if (neighbor == end) return dist;
                if (visited.add(neighbor)) queue.offer(neighbor);
            }
        }
    }
    return -1;
}
// Time: O(V + E), Space: O(V)
```

### Template: DFS — Connected Components / Cycle Detection

```java
public void dfs(int node, Map<Integer, List<Integer>> graph, Set<Integer> visited) {
    visited.add(node);
    for (int neighbor : graph.getOrDefault(node, List.of())) {
        if (!visited.contains(neighbor)) dfs(neighbor, graph, visited);
    }
}

public int countComponents(int n, int[][] edges) {
    Map<Integer, List<Integer>> graph = buildGraph(n, edges);
    Set<Integer> visited = new HashSet<>();
    int count = 0;
    for (int i = 0; i < n; i++) {
        if (!visited.contains(i)) {
            dfs(i, graph, visited);
            count++;
        }
    }
    return count;
}
```

### Template: Dijkstra (Non-negative weights) — Simplified

```java
public int[] dijkstra(List<List<int[]>> graph, int src) {
    int n = graph.size();
    int[] dist = new int[n];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[src] = 0;

    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[1] - b[1]);
    pq.offer(new int[]{src, 0});

    while (!pq.isEmpty()) {
        int[] curr = pq.poll();
        int node = curr[0], d = curr[1];
        if (d > dist[node]) continue; // stale entry

        for (int[] edge : graph.get(node)) {
            int neighbor = edge[0], weight = edge[1];
            if (dist[node] + weight < dist[neighbor]) {
                dist[neighbor] = dist[node] + weight;
                pq.offer(new int[]{neighbor, dist[neighbor]});
            }
        }
    }
    return dist;
}
// Time: O((V + E) log V) with binary heap
```

### Problem 1: Number of Islands (LC 200)

```java
public int numIslands(char[][] grid) {
    int count = 0;
    for (int r = 0; r < grid.length; r++) {
        for (int c = 0; c < grid[0].length; c++) {
            if (grid[r][c] == '1') {
                dfs(grid, r, c);
                count++;
            }
        }
    }
    return count;
}

private void dfs(char[][] grid, int r, int c) {
    if (r < 0 || c < 0 || r >= grid.length || c >= grid[0].length || grid[r][c] == '0')
        return;
    grid[r][c] = '0';
    dfs(grid, r + 1, c);
    dfs(grid, r - 1, c);
    dfs(grid, r, c + 1);
    dfs(grid, r, c - 1);
}
```

| Time | Space |
|------|-------|
| O(rows × cols) | O(rows × cols) worst case recursion |

**Production analogy:** Flood-fill region detection in image processing or network partition discovery.

### Problem 2: Course Schedule (LC 207) — Cycle Detection (Topological Sort)

```java
public boolean canFinish(int numCourses, int[][] prerequisites) {
    List<List<Integer>> graph = new ArrayList<>();
    int[] inDegree = new int[numCourses];
    for (int i = 0; i < numCourses; i++) graph.add(new ArrayList<>());

    for (int[] pre : prerequisites) {
        graph.get(pre[1]).add(pre[0]);
        inDegree[pre[0]]++;
    }

    Queue<Integer> queue = new ArrayDeque<>();
    for (int i = 0; i < numCourses; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }

    int completed = 0;
    while (!queue.isEmpty()) {
        int course = queue.poll();
        completed++;
        for (int next : graph.get(course)) {
            if (--inDegree[next] == 0) queue.offer(next);
        }
    }
    return completed == numCourses;
}
```

| Time | Space |
|------|-------|
| O(V + E) | O(V + E) |

**Production analogy:** Build pipeline / DAG task scheduler (Gradle, Airflow).

### Problem 3: Word Ladder (LC 127) — BFS Shortest Transformation

```java
public int ladderLength(String beginWord, String endWord, List<String> wordList) {
    Set<String> dict = new HashSet<>(wordList);
    if (!dict.contains(endWord)) return 0;

    Queue<String> queue = new ArrayDeque<>();
    queue.offer(beginWord);
    Set<String> visited = new HashSet<>();
    visited.add(beginWord);
    int level = 1;

    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            String word = queue.poll();
            char[] chars = word.toCharArray();
            for (int j = 0; j < chars.length; j++) {
                char orig = chars[j];
                for (char c = 'a'; c <= 'z'; c++) {
                    chars[j] = c;
                    String next = new String(chars);
                    if (next.equals(endWord)) return level + 1;
                    if (dict.contains(next) && visited.add(next)) {
                        queue.offer(next);
                    }
                }
                chars[j] = orig;
            }
        }
        level++;
    }
    return 0;
}
```

| Time | Space |
|------|-------|
| O(M² × N) where M = word length, N = word list size | O(N) |

**Production analogy:** Minimum migration steps between configuration states (each step changes one attribute).

---

## 10. Heap / Priority Queue (Top K)

### When to Use

- **Top K / Bottom K** elements
- **Merge K sorted** lists/streams
- **Dijkstra** shortest path
- **Median** from stream (two heaps)
- **Task scheduling** by priority

### Key Insight: Min-Heap of Size K for Top K Largest

Keep K largest → use **min-heap** of size K. If new element > heap min, replace.

### Template: Top K Frequent Elements (LC 347)

```java
public int[] topKFrequent(int[] nums, int k) {
    Map<Integer, Integer> freq = new HashMap<>();
    for (int n : nums) freq.merge(n, 1, Integer::sum);

    PriorityQueue<Integer> minHeap = new PriorityQueue<>(
        (a, b) -> freq.get(a) - freq.get(b)
    );
    for (int num : freq.keySet()) {
        minHeap.offer(num);
        if (minHeap.size() > k) minHeap.poll();
    }

    return minHeap.stream().mapToInt(Integer::intValue).toArray();
}
// Time: O(n + m log k) where m = unique elements
// Space: O(m + k)
```

### Template: Merge K Sorted Lists (LC 23)

```java
public ListNode mergeKLists(ListNode[] lists) {
    PriorityQueue<ListNode> pq = new PriorityQueue<>((a, b) -> a.val - b.val);
    for (ListNode node : lists) {
        if (node != null) pq.offer(node);
    }
    ListNode dummy = new ListNode(0), tail = dummy;
    while (!pq.isEmpty()) {
        ListNode node = pq.poll();
        tail.next = node;
        tail = tail.next;
        if (node.next != null) pq.offer(node.next);
    }
    return dummy.next;
}
// Time: O(N log k) where N = total nodes, k = lists
```

### Template: Find Median from Data Stream (LC 295)

```java
class MedianFinder {
    private final PriorityQueue<Integer> lo = new PriorityQueue<>(Collections.reverseOrder());
    private final PriorityQueue<Integer> hi = new PriorityQueue<>();

    public void addNum(int num) {
        lo.offer(num);
        hi.offer(lo.poll());
        if (lo.size() < hi.size()) lo.offer(hi.poll());
    }

    public double findMedian() {
        return lo.size() > hi.size() ? lo.peek() : (lo.peek() + hi.peek()) / 2.0;
    }
}
// addNum: O(log n), findMedian: O(1)
```

### Problem 1: Kth Largest Element (LC 215)

```java
// Quickselect average O(n), or min-heap O(n log k)
public int findKthLargest(int[] nums, int k) {
    PriorityQueue<Integer> minHeap = new PriorityQueue<>();
    for (int n : nums) {
        minHeap.offer(n);
        if (minHeap.size() > k) minHeap.poll();
    }
    return minHeap.peek();
}
```

### Problem 2: Task Scheduler (LC 621)

```java
public int leastInterval(char[] tasks, int n) {
    int[] freq = new int[26];
    for (char t : tasks) freq[t - 'A']++;

    PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Collections.reverseOrder());
    for (int f : freq) if (f > 0) maxHeap.offer(f);

    int time = 0;
    while (!maxHeap.isEmpty()) {
        List<Integer> cooldown = new ArrayList<>();
        for (int i = 0; i <= n; i++) {
            if (!maxHeap.isEmpty()) {
                int count = maxHeap.poll() - 1;
                if (count > 0) cooldown.add(count);
            }
            time++;
            if (maxHeap.isEmpty() && cooldown.isEmpty()) break;
        }
        maxHeap.addAll(cooldown);
    }
    return time;
}
```

| Time | Space |
|------|-------|
| O(m) where m = total executions | O(1) — 26 letters |

**Production analogy:** CPU task scheduling with cooldown periods (rate limiting, thermal throttling).

### Problem 3: Reorganize String (LC 767)

```java
public String reorganizeString(String s) {
    int[] freq = new int[26];
    for (char c : s.toCharArray()) freq[c - 'a']++;

    PriorityQueue<int[]> maxHeap = new PriorityQueue<>((a, b) -> b[1] - a[1]);
    for (int i = 0; i < 26; i++) {
        if (freq[i] > 0) maxHeap.offer(new int[]{i, freq[i]});
    }

    StringBuilder sb = new StringBuilder();
    int[] prev = null;

    while (!maxHeap.isEmpty()) {
        int[] curr = maxHeap.poll();
        sb.append((char) ('a' + curr[0]));
        curr[1]--;
        if (prev != null && prev[1] > 0) maxHeap.offer(prev);
        prev = curr[1] > 0 ? curr : null;
    }
    return sb.length() == s.length() ? sb.toString() : "";
}
```

**Production analogy:** Spread identical jobs across time slots to avoid hotspotting.

---

## 11. Union-Find (Disjoint Set)

### When to Use

- **Dynamic connectivity** — are A and B connected?
- **Count connected components** as edges are added
- **Detect cycles** in undirected graphs
- **Kruskal's MST** algorithm
- **Percolation** problems

### Template: Union-Find with Path Compression + Union by Rank

```java
class UnionFind {
    private final int[] parent;
    private final int[] rank;
    private int components;

    UnionFind(int n) {
        parent = new int[n];
        rank = new int[n];
        components = n;
        for (int i = 0; i < n; i++) parent[i] = i;
    }

    int find(int x) {
        if (parent[x] != x) parent[x] = find(parent[x]); // path compression
        return parent[x];
    }

    boolean union(int x, int y) {
        int px = find(x), py = find(y);
        if (px == py) return false;
        if (rank[px] < rank[py]) { int t = px; px = py; py = t; }
        parent[py] = px;
        if (rank[px] == rank[py]) rank[px]++;
        components--;
        return true;
    }

    boolean connected(int x, int y) { return find(x) == find(y); }
    int getComponents() { return components; }
}
// amortized O(α(n)) ≈ O(1) per operation
```

### Problem 1: Number of Provinces (LC 547)

```java
public int findCircleNum(int[][] isConnected) {
    int n = isConnected.length;
    UnionFind uf = new UnionFind(n);
    for (int i = 0; i < n; i++) {
        for (int j = i + 1; j < n; j++) {
            if (isConnected[i][j] == 1) uf.union(i, j);
        }
    }
    return uf.getComponents();
}
```

| Time | Space |
|------|-------|
| O(n² α(n)) | O(n) |

### Problem 2: Redundant Connection (LC 684) — Cycle Detection

```java
public int[] findRedundantConnection(int[][] edges) {
    UnionFind uf = new UnionFind(edges.length + 1);
    for (int[] edge : edges) {
        if (!uf.union(edge[0], edge[1])) return edge; // already connected → cycle
    }
    return new int[]{};
}
```

### Problem 3: Accounts Merge (LC 721)

```java
public List<List<String>> accountsMerge(List<List<String>> accounts) {
    UnionFind uf = new UnionFind(accounts.size());
    Map<String, Integer> emailToId = new HashMap<>();

    for (int i = 0; i < accounts.size(); i++) {
        for (int j = 1; j < accounts.get(i).size(); j++) {
            String email = accounts.get(i).get(j);
            if (emailToId.containsKey(email)) {
                uf.union(i, emailToId.get(email));
            } else {
                emailToId.put(email, i);
            }
        }
    }

    Map<Integer, Set<String>> groups = new HashMap<>();
    for (int i = 0; i < accounts.size(); i++) {
        int root = uf.find(i);
        groups.computeIfAbsent(root, k -> new TreeSet<>());
        for (int j = 1; j < accounts.get(i).size(); j++) {
            groups.get(root).add(accounts.get(i).get(j));
        }
    }

    List<List<String>> result = new ArrayList<>();
    for (var entry : groups.entrySet()) {
        List<String> merged = new ArrayList<>();
        merged.add(accounts.get(entry.getKey()).get(0));
        merged.addAll(entry.getValue());
        result.add(merged);
    }
    return result;
}
```

**Production analogy:** Network peering — merge routing domains when shared identifiers appear; Kruskal MST for minimum-cost network backbone.

---

## 12. Dynamic Programming

### When to Use

- **Optimal substructure** — optimal solution built from optimal subsolutions
- **Overlapping subproblems** — same subproblem solved repeatedly
- Keywords: "count ways", "minimum/maximum", "can you partition", "longest"

### DP Approach Steps

1. Define state: `dp[i]` or `dp[i][j]` meaning
2. Recurrence relation
3. Base cases
4. Iteration order (fill dependencies first)
5. Return target state
6. Optional: space optimization, path reconstruction

### 1D DP Template

```java
// Fibonacci-style
int[] dp = new int[n + 1];
dp[0] = base0;
dp[1] = base1;
for (int i = 2; i <= n; i++) {
    dp[i] = dp[i-1] + dp[i-2]; // recurrence
}
```

### Problem 1: Climbing Stairs (LC 70)

```java
public int climbStairs(int n) {
    if (n <= 2) return n;
    int prev2 = 1, prev1 = 2;
    for (int i = 3; i <= n; i++) {
        int curr = prev1 + prev2;
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
```

| Time | Space |
|------|-------|
| O(n) | O(1) |

### Problem 2: Coin Change (LC 322)

```java
public int coinChange(int[] coins, int amount) {
    int[] dp = new int[amount + 1];
    Arrays.fill(dp, amount + 1);
    dp[0] = 0;

    for (int i = 1; i <= amount; i++) {
        for (int coin : coins) {
            if (coin <= i) {
                dp[i] = Math.min(dp[i], dp[i - coin] + 1);
            }
        }
    }
    return dp[amount] > amount ? -1 : dp[amount];
}
```

| Time | Space |
|------|-------|
| O(amount × coins.length) | O(amount) |

**Production analogy:** Minimum API calls to reach a quota using fixed bundle sizes.

### Problem 3: Longest Increasing Subsequence (LC 300)

```java
// O(n log n) with patience sorting / binary search
public int lengthOfLIS(int[] nums) {
    int[] tails = new int[nums.length];
    int size = 0;
    for (int n : nums) {
        int lo = 0, hi = size;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (tails[mid] < n) lo = mid + 1;
            else hi = mid;
        }
        tails[lo] = n;
        if (lo == size) size++;
    }
    return size;
}
```

| Time | Space |
|------|-------|
| O(n log n) | O(n) |

**Production analogy:** Longest strictly increasing metric timeline for SLA trending.

### 2D DP Template — Grid Path

```java
public int uniquePaths(int m, int n) {
    int[] dp = new int[n];
    Arrays.fill(dp, 1);
    for (int i = 1; i < m; i++) {
        for (int j = 1; j < n; j++) {
            dp[j] += dp[j - 1];
        }
    }
    return dp[n - 1];
}
```

### Problem 4: 0/1 Knapsack

```java
public int knapsack(int[] weights, int[] values, int capacity) {
    int[] dp = new int[capacity + 1];
    for (int i = 0; i < weights.length; i++) {
        for (int w = capacity; w >= weights[i]; w--) { // reverse for 0/1
            dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
        }
    }
    return dp[capacity];
}
```

| Time | Space |
|------|-------|
| O(n × capacity) | O(capacity) |

**Production analogy:** Resource allocation under budget — maximize value with weight/cost constraints (cloud instance packing).

### Problem 5: Edit Distance (LC 72)

```java
public int minDistance(String word1, String word2) {
    int m = word1.length(), n = word2.length();
    int[] prev = new int[n + 1];
    int[] curr = new int[n + 1];

    for (int j = 0; j <= n; j++) prev[j] = j;

    for (int i = 1; i <= m; i++) {
        curr[0] = i;
        for (int j = 1; j <= n; j++) {
            if (word1.charAt(i - 1) == word2.charAt(j - 1)) {
                curr[j] = prev[j - 1];
            } else {
                curr[j] = 1 + Math.min(prev[j - 1], Math.min(prev[j], curr[j - 1]));
            }
        }
        int[] temp = prev; prev = curr; curr = temp;
    }
    return prev[n];
}
```

| Time | Space |
|------|-------|
| O(m × n) | O(n) |

**Production analogy:** Diff algorithms, fuzzy matching, spell-check suggestions.

### Problem 6: House Robber (LC 198)

```java
public int rob(int[] nums) {
    int prev2 = 0, prev1 = 0;
    for (int n : nums) {
        int curr = Math.max(prev1, prev2 + n);
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
```

### DP Pattern Summary

| Pattern | Example problems | State |
|---------|------------------|-------|
| Linear 1D | Climbing stairs, robber | `dp[i]` |
| Unbounded knapsack | Coin change | `dp[amount]` |
| 0/1 Knapsack | Subset sum, partition | `dp[i][w]` |
| LIS | LIS, Russian dolls | `tails[]` + BS |
| Grid | Unique paths, min path sum | `dp[row][col]` |
| String DP | Edit distance, LCS | `dp[i][j]` |
| Interval DP | Burst balloons, matrix chain | `dp[i][j]` interval |

---

## 13. Backtracking

### When to Use

- **Generate all** combinations, permutations, subsets
- **Constraint satisfaction** — N-Queens, Sudoku
- **Search with pruning** when brute force is exponential but constraints eliminate branches

### Template

```java
void backtrack(state, choices, result) {
    if (isComplete(state)) {
        result.add(copy(state));
        return;
    }
    for (choice : choices) {
        if (!isValid(choice)) continue;      // prune
        makeChoice(state, choice);
        backtrack(state, nextChoices, result);
        undoChoice(state, choice);           // backtrack
    }
}
```

### Problem 1: Subsets (LC 78)

```java
public List<List<Integer>> subsets(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(nums, 0, new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] nums, int start, List<Integer> path, List<List<Integer>> result) {
    result.add(new ArrayList<>(path));
    for (int i = start; i < nums.length; i++) {
        path.add(nums[i]);
        backtrack(nums, i + 1, path, result);
        path.remove(path.size() - 1);
    }
}
```

| Time | Space |
|------|-------|
| O(2ⁿ) | O(n) recursion |

### Problem 2: Permutations (LC 46)

```java
public List<List<Integer>> permute(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    boolean[] used = new boolean[nums.length];
    backtrack(nums, used, new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] nums, boolean[] used, List<Integer> path, List<List<Integer>> result) {
    if (path.size() == nums.length) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (int i = 0; i < nums.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        path.add(nums[i]);
        backtrack(nums, used, path, result);
        path.remove(path.size() - 1);
        used[i] = false;
    }
}
```

### Problem 3: Combination Sum (LC 39)

```java
public List<List<Integer>> combinationSum(int[] candidates, int target) {
    List<List<Integer>> result = new ArrayList<>();
    Arrays.sort(candidates);
    backtrack(candidates, target, 0, new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] candidates, int remain, int start,
                       List<Integer> path, List<List<Integer>> result) {
    if (remain == 0) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (int i = start; i < candidates.length; i++) {
        if (candidates[i] > remain) break; // sorted pruning
        path.add(candidates[i]);
        backtrack(candidates, remain - candidates[i], i, path, result);
        path.remove(path.size() - 1);
    }
}
```

**Production analogy:** Config generator — enumerate valid feature flag combinations under constraints; test case generation.

### Problem 4: Word Search (LC 79)

```java
public boolean exist(char[][] board, String word) {
    for (int r = 0; r < board.length; r++) {
        for (int c = 0; c < board[0].length; c++) {
            if (dfs(board, word, r, c, 0)) return true;
        }
    }
    return false;
}

private boolean dfs(char[][] board, String word, int r, int c, int idx) {
    if (idx == word.length()) return true;
    if (r < 0 || c < 0 || r >= board.length || c >= board[0].length) return false;
    if (board[r][c] != word.charAt(idx)) return false;

    char temp = board[r][c];
    board[r][c] = '#';
    boolean found = dfs(board, word, r+1, c, idx+1)
                 || dfs(board, word, r-1, c, idx+1)
                 || dfs(board, word, r, c+1, idx+1)
                 || dfs(board, word, r, c-1, idx+1);
    board[r][c] = temp;
    return found;
}
```

---

## 14. Trie

### When to Use

- **Prefix search** — autocomplete, typeahead
- **Dictionary** with efficient prefix queries
- **Word search** in grid with multiple words (Trie + backtracking)
- **XOR maximum** problems (binary trie — advanced)

### Template

```java
class TrieNode {
    TrieNode[] children = new TrieNode[26];
    boolean isEnd;
}

class Trie {
    private final TrieNode root = new TrieNode();

    public void insert(String word) {
        TrieNode node = root;
        for (char c : word.toCharArray()) {
            int i = c - 'a';
            if (node.children[i] == null) node.children[i] = new TrieNode();
            node = node.children[i];
        }
        node.isEnd = true;
    }

    public boolean search(String word) {
        TrieNode node = find(word);
        return node != null && node.isEnd;
    }

    public boolean startsWith(String prefix) {
        return find(prefix) != null;
    }

    private TrieNode find(String s) {
        TrieNode node = root;
        for (char c : s.toCharArray()) {
            int i = c - 'a';
            if (node.children[i] == null) return null;
            node = node.children[i];
        }
        return node;
    }
}
// insert/search: O(m) where m = word length
```

### Problem 1: Implement Trie (LC 208)

See template above.

### Problem 2: Word Search II (LC 212)

```java
public List<String> findWords(char[][] board, String[] words) {
    TrieNode root = buildTrie(words);
    List<String> result = new ArrayList<>();
    Set<String> found = new HashSet<>();

    for (int r = 0; r < board.length; r++) {
        for (int c = 0; c < board[0].length; c++) {
            dfs(board, r, c, root, new StringBuilder(), found);
        }
    }
    return new ArrayList<>(found);
}

private void dfs(char[][] board, int r, int c, TrieNode node,
                 StringBuilder sb, Set<String> found) {
    if (r < 0 || c < 0 || r >= board.length || c >= board[0].length) return;
    if (board[r][c] == '#') return;

    char ch = board[r][c];
    int idx = ch - 'a';
    if (node.children[idx] == null) return;

    node = node.children[idx];
    sb.append(ch);
    if (node.isEnd) found.add(sb.toString());

    board[r][c] = '#';
    dfs(board, r+1, c, node, sb, found);
    dfs(board, r-1, c, node, sb, found);
    dfs(board, r, c+1, node, sb, found);
    dfs(board, r, c-1, node, sb, found);
    board[r][c] = ch;
    sb.deleteCharAt(sb.length() - 1);
}
```

| Time | Space |
|------|-------|
| O(m × n × 4^L) worst case | O(total chars in words) |

**Production analogy:** Elasticsearch completion suggester, DNS prefix routing, IDE autocomplete indexes.

### Problem 3: Replace Words (LC 648)

```java
public String replaceWords(List<String> dictionary, String sentence) {
    Trie trie = new Trie();
    for (String root : dictionary) trie.insert(root);

    StringBuilder sb = new StringBuilder();
    for (String word : sentence.split(" ")) {
        if (sb.length() > 0) sb.append(' ');
        sb.append(shortestRoot(trie, word));
    }
    return sb.toString();
}

private String shortestRoot(Trie trie, String word) {
    StringBuilder prefix = new StringBuilder();
    for (char c : word.toCharArray()) {
        prefix.append(c);
        if (trie.startsWith(prefix.toString())) {
            if (trie.search(prefix.toString())) return prefix.toString();
        } else break;
    }
    return word;
}
```

---

## 15. LRU Cache

### When to Use

- **Bounded cache** with eviction policy
- **Memory-constrained** hot data retention
- Classic system design + coding combo question

### Approach 1: LinkedHashMap (Interview-acceptable, production-used)

```java
class LRUCache extends LinkedHashMap<Integer, Integer> {
    private final int capacity;

    LRUCache(int capacity) {
        super(capacity, 0.75f, true); // accessOrder = true
        this.capacity = capacity;
    }

    public int get(int key) {
        return super.getOrDefault(key, -1);
    }

    public void put(int key, int value) {
        super.put(key, value);
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<Integer, Integer> eldest) {
        return size() > capacity;
    }
}
// get/put: O(1)
```

### Approach 2: Custom Doubly Linked List + HashMap (Full Control)

```java
class LRUCache {
    class Node {
        int key, value;
        Node prev, next;
        Node(int k, int v) { key = k; value = v; }
    }

    private final int capacity;
    private final Map<Integer, Node> map = new HashMap<>();
    private final Node head = new Node(0, 0); // dummy
    private final Node tail = new Node(0, 0);

    public LRUCache(int capacity) {
        this.capacity = capacity;
        head.next = tail;
        tail.prev = head;
    }

    public int get(int key) {
        if (!map.containsKey(key)) return -1;
        Node node = map.get(key);
        moveToHead(node);
        return node.value;
    }

    public void put(int key, int value) {
        if (map.containsKey(key)) {
            Node node = map.get(key);
            node.value = value;
            moveToHead(node);
        } else {
            Node node = new Node(key, value);
            map.put(key, node);
            addToHead(node);
            if (map.size() > capacity) {
                Node lru = removeTail();
                map.remove(lru.key);
            }
        }
    }

    private void addToHead(Node node) {
        node.prev = head;
        node.next = head.next;
        head.next.prev = node;
        head.next = node;
    }

    private void removeNode(Node node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }

    private void moveToHead(Node node) {
        removeNode(node);
        addToHead(node);
    }

    private Node removeTail() {
        Node node = tail.prev;
        removeNode(node);
        return node;
    }
}
```

| Operation | Time | Space |
|-----------|------|-------|
| get | O(1) | O(capacity) |
| put | O(1) | O(capacity) |

### Problem: LRU Cache (LC 146)

Use custom implementation above.

**Production analogies:**
- **Redis** `maxmemory-policy allkeys-lru` — approximate LRU at scale
- **Caffeine cache** in Spring — W-TinyLFU (better than LRU for skewed workloads)
- **CPU cache lines** — hardware LRU-ish eviction
- **CDN edge caching** — evict cold content under storage limits
- **Database buffer pool** — InnoDB uses LRU variant for page cache

### LFU vs LRU — Senior Discussion Point

| Policy | Best when | Weakness |
|--------|-----------|----------|
| LRU | Temporal locality, recency matters | One-time scans pollute cache |
| LFU | Frequency matters, hot keys stable | Slow to adapt to shifting patterns |
| TTL + LRU | Session caches, API responses | Stale data if TTL too long |

---

## 16. Concurrency-Safe Structures (Brief)

Senior interviews may ask: "How would you make this thread-safe in production?"

### Java Concurrent Collections

```java
ConcurrentHashMap<K, V>  // lock-striped, O(1) concurrent reads/writes
CopyOnWriteArrayList<E>  // read-heavy, snapshot iterator
ConcurrentLinkedQueue<E> // lock-free MPMC queue
BlockingQueue<E>         // producer-consumer with backpressure
```

### LRU Cache — Thread Safety

```java
class ConcurrentLRUCache<K, V> {
    private final int capacity;
    private final LinkedHashMap<K, V> map;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    ConcurrentLRUCache(int capacity) {
        this.capacity = capacity;
        this.map = new LinkedHashMap<>(capacity, 0.75f, true) {
            @Override protected boolean removeEldestEntry(Map.Entry<K, V> e) {
                return size() > ConcurrentLRUCache.this.capacity;
            }
        };
    }

    public V get(K key) {
        lock.readLock().lock();
        try { return map.get(key); }
        finally { lock.readLock().unlock(); }
    }

    public void put(K key, V value) {
        lock.writeLock().lock();
        try { map.put(key, value); }
        finally { lock.writeLock().unlock(); }
    }
}
```

**Better production choice:** Use **Caffeine** `Cache<K,V>` with `maximumSize()` and built-in concurrency.

### Rate Limiter — Token Bucket (Coding + System Design)

```java
class TokenBucket {
    private final long capacity;
    private final long refillRatePerMs;
    private long tokens;
    private long lastRefillNanos;

    TokenBucket(long capacity, long refillPerSecond) {
        this.capacity = capacity;
        this.refillRatePerMs = refillPerSecond / 1000;
        this.tokens = capacity;
        this.lastRefillNanos = System.nanoTime();
    }

    synchronized boolean tryAcquire() {
        refill();
        if (tokens > 0) { tokens--; return true; }
        return false;
    }

    private void refill() {
        long now = System.nanoTime();
        long elapsed = (now - lastRefillNanos) / 1_000_000;
        tokens = Math.min(capacity, tokens + elapsed * refillRatePerMs);
        lastRefillNanos = now;
    }
}
```

**Production analogy:** API gateway rate limiting (Kong, Envoy), S3 request throttling.

### Thread-Safe Singleton (Double-Checked Locking)

```java
class ConfigHolder {
    private static volatile ConfigHolder instance;

    static ConfigHolder getInstance() {
        if (instance == null) {
            synchronized (ConfigHolder.class) {
                if (instance == null) instance = new ConfigHolder();
            }
        }
        return instance;
    }
}
```

Prefer **enum singleton** or **dependency injection** in real Spring applications.

---

## 17. Scenario Q&A — Patterns Meet System Design

### Q1: Why is LRU used in caching layers?

**Answer:** LRU exploits **temporal locality** — recently accessed data is likely accessed again. It provides O(1) get/put with bounded memory. In Redis, Memcached, and CDN caches, when memory is full, evicting the least-recently-used item minimizes expected cache miss rate for typical workloads. Caveat: scan-heavy workloads defeat LRU — use TTL or LFU (Caffeine's W-TinyLFU) instead.

**Pattern link:** Hash map + doubly linked list (LRU Cache, LC 146).

---

### Q2: How would you find duplicate request IDs in a stream of millions of events?

**Answer:** Use `HashSet` for exact dedup if memory fits. For bounded memory at scale, use **Bloom filter** (probabilistic) + backend confirmation, or partition by hash mod N and dedup per partition. For time-windowed dedup, sliding window + `HashMap<id, timestamp>` with eviction.

**Pattern link:** Hash set, sliding window.

---

### Q3: Design a top-K trending hashtags system. What algorithm?

**Answer:** Maintain counts in `HashMap<tag, count>`. For top K, use **min-heap of size K** updated per event — O(log K) per update. At query time, return heap contents. For distributed: Count-Min Sketch + periodic aggregation, or stream processing (Flink) with keyed state.

**Pattern link:** Heap top-K (LC 347), hash map frequency.

---

### Q4: How do you detect a cycle in a microservice dependency graph?

**Answer:** Model services as nodes, calls as directed edges. Run **topological sort** (Kahn's BFS) or **DFS with three-color marking** (white/gray/black). If topological sort can't process all nodes, cycle exists. In production: CI pipeline validates dependency DAG.

**Pattern link:** Course Schedule (LC 207), graph DFS.

---

### Q5: Merge overlapping calendar events for a scheduling service.

**Answer:** Sort intervals by start time, merge in one pass. O(n log n). Alternative: sweep line with priority queue of end times for meeting room count.

**Pattern link:** Merge Intervals (LC 56), Meeting Rooms II (LC 253).

---

### Q6: Find shortest network path between two nodes with latency weights.

**Answer:** Non-negative weights → **Dijkstra** with priority queue. O((V+E) log V). All-pairs → Floyd-Warshall O(V³) or repeated Dijkstra. Negative weights → Bellman-Ford. Production: BGP routing, service mesh sidecar routing.

**Pattern link:** Graph BFS (unweighted), Dijkstra template.

---

### Q7: Autocomplete for 10M product names — data structure?

**Answer:** **Trie** (prefix tree) for prefix lookup O(m) where m = prefix length. Compress with DAWG for memory. Rank suggestions by frequency (top-K heap per prefix node, or precomputed at build time). Production: Elasticsearch completion suggester, Redis with sorted sets per prefix.

**Pattern link:** Trie (LC 208, 212).

---

### Q8: Partition users into friend groups (connected components).

**Answer:** Build undirected graph from friendships. **Union-Find** or DFS to count components. Union-Find handles dynamic `union` queries efficiently. Production: social graph analytics, recommendation clusters.

**Pattern link:** Union-Find (LC 547), Number of Islands.

---

### Q9: Minimum coins to make change at a vending machine API.

**Answer:** Unbounded knapsack / coin change DP. O(amount × denominations). Greedy works only for canonical coin systems (e.g., US coins). Always clarify whether greedy is valid.

**Pattern link:** Coin Change (LC 322).

---

### Q10: Rate-limit API calls — 100 requests per minute per user.

**Answer:** **Sliding window** counter or token bucket per user (`HashMap<userId, Window>`). Sliding window log uses deque of timestamps. Fixed window is simpler but allows burst at boundaries. Production: Redis INCR with TTL, or dedicated rate limiter (Guava RateLimiter).

**Pattern link:** Sliding window, hash map.

---

### Q11: Find if two strings are anagrams at login (nonce validation).

**Answer:** Count characters with `int[26]` or `HashMap`. O(n) time, O(1) space for fixed alphabet. Sorting both strings is O(n log n) — mention but prefer counting.

**Pattern link:** Hash map frequency, Group Anagrams.

---

### Q12: Serialize and deserialize a binary tree for message queue transport.

**Answer:** BFS or preorder with null markers. `Codec` pattern from LC 297. Discuss JSON vs binary format, schema evolution, and idempotency of deserialization.

**Pattern link:** Tree BFS/DFS traversals.

---

### Q13: Find the k-th largest response time in last hour from metrics stream.

**Answer:** **Min-heap of size K** over streaming data. If windowed, combine sliding window bucket with heap per bucket, or use approximate quantiles (t-digest) at scale.

**Pattern link:** Top K heap (LC 215, 347).

---

### Q14: Validate nested JSON brackets in an API gateway.

**Answer:** Stack-based bracket matching. O(n) single pass. Extend for string-aware parsing (ignore brackets inside quotes).

**Pattern link:** Valid Parentheses (LC 20), stack.

---

### Q15: Optimize route visiting all warehouses (TSP variant).

**Answer:** Full TSP is NP-hard. For interviews: mention brute force/backtracking for small n, DP with bitmask for n ≤ 20, heuristics (nearest neighbor) for production. Clarify constraints before coding.

**Pattern link:** Backtracking, DP (bitmask TSP).

---

### Q16: Deduplicate URLs crawled by a web spider across distributed workers.

**Answer:** Central **Trie** or **HashSet** doesn't scale. Use **Bloom filter** per worker + shared Redis set for confirmed URLs, or consistent hashing to partition URL space. Union-Find not needed unless merging equivalence classes.

**Pattern link:** Hash set, Trie, production distributed structures.

---

### Q17: Find longest stable version sequence in deployment history.

**Answer:** Longest Increasing Subsequence on version tuples or encoded version numbers. O(n log n). Production: identify longest period without rollback.

**Pattern link:** LIS (LC 300).

---

### Q18: Implement undo/redo in a collaborative document editor.

**Answer:** Two stacks: undo stack and redo stack. Each operation pushed to undo. Undo pops to redo. For collaboration, discuss OT or CRDT — beyond simple stack, but stack is the local interview answer.

**Pattern link:** Stack.

---

### Q19: Why use monotonic deque for sliding window maximum in real-time analytics?

**Answer:** Naive window max is O(n × k). Monotonic deque maintains candidates in decreasing order — each element enters and exits once → O(n). Used in stream processing for rolling max latency dashboards.

**Pattern link:** Sliding Window Maximum (LC 239).

---

### Q20: Database deadlock detection — graph algorithm?

**Answer:** Model transactions as nodes, lock waits as directed edges. **Cycle detection** via DFS detects deadlock. Production DBs run deadlock detector periodically. Topological sort doesn't apply to cyclic wait graphs.

**Pattern link:** Graph cycle detection, DFS.

---

## 18. Quick Reference Cheat Sheet

### Pattern → Complexity → Classic Problem

| Pattern | Typical Time | Typical Space | Classic Problem |
|---------|--------------|---------------|-----------------|
| Hash map lookup | O(n) | O(n) | Two Sum |
| Two pointers | O(n) | O(1) | Container With Most Water |
| Sliding window | O(n) | O(k) | Min Window Substring |
| Binary search | O(log n) | O(1) | Search Rotated Array |
| Sort + scan | O(n log n) | O(1) | Merge Intervals |
| Monotonic stack | O(n) | O(n) | Daily Temperatures |
| Tree BFS | O(n) | O(w) | Level Order |
| Tree DFS | O(n) | O(h) | Max Path Sum |
| Graph BFS | O(V+E) | O(V) | Word Ladder |
| Graph DFS | O(V+E) | O(V) | Number of Islands |
| Dijkstra | O((V+E) log V) | O(V) | Network Delay Time |
| Min heap top-K | O(n log k) | O(k) | Top K Frequent |
| Union-Find | O(α(n)) per op | O(n) | Redundant Connection |
| 1D DP | O(n) | O(n) or O(1) | House Robber |
| 2D DP | O(m×n) | O(n) | Edit Distance |
| Backtracking | O(2ⁿ) or O(n!) | O(n) | Permutations |
| Trie | O(m) per op | O(total chars) | Word Search II |
| LRU cache | O(1) | O(capacity) | LRU Cache |

### Java Imports to Remember

```java
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.locks.*;
```

### Edge Cases Checklist

- [ ] Empty input (null, `[]`, `""`)
- [ ] Single element
- [ ] All same elements
- [ ] Already sorted / reverse sorted
- [ ] Integer overflow (`long`, `mid = lo + (hi-lo)/2`)
- [ ] Duplicate values
- [ ] Negative numbers
- [ ] Graph disconnected
- [ ] Cycle present / absent

### Senior Interview Closing Statements

When you finish coding, proactively mention:

1. **Complexity:** "Time O(n log n) for sort, O(n) for scan; space O(n) for the hash map."
2. **Scale:** "For billions of rows, this in-memory approach won't work — I'd use a distributed sort or streaming algorithm."
3. **Testing:** "I'd unit test edge cases: empty, single element, duplicates, and a happy path."
4. **Production:** "In our service we'd use Caffeine for caching rather than rolling our own LRU."
5. **Follow-up readiness:** "If we need persistence, I'd back this with Redis; if we need strong consistency, we'd add locking."

---

## Appendix A: Bit Manipulation Essentials

```java
// Check i-th bit set
boolean isSet = (n & (1 << i)) != 0;

// Set i-th bit
n |= (1 << i);

// Clear i-th bit
n &= ~(1 << i);

// Toggle i-th bit
n ^= (1 << i);

// Count set bits — Integer.bitCount(n)

// Power of two
boolean isPow2 = n > 0 && (n & (n - 1)) == 0;

// XOR trick — find single number appearing once (LC 136)
int xor = 0;
for (int n : nums) xor ^= n;
```

**Production analogy:** Feature flags in a single `int` bitmask; permission sets in RBAC.

---

## Appendix B: Interval Scheduling Greedy

```java
// Maximum non-overlapping intervals
public int eraseOverlapIntervals(int[][] intervals) {
    if (intervals.length == 0) return 0;
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));
    int count = 1, end = intervals[0][1];
    for (int i = 1; i < intervals.length; i++) {
        if (intervals[i][0] >= end) {
            count++;
            end = intervals[i][1];
        }
    }
    return intervals.length - count;
}
```

**Production analogy:** Job scheduling on a single worker — maximize completed jobs.

---

## Appendix C: Prefix Sum Template

```java
class PrefixSum {
    private final long[] prefix;

    PrefixSum(int[] nums) {
        prefix = new long[nums.length + 1];
        for (int i = 0; i < nums.length; i++) {
            prefix[i + 1] = prefix[i] + nums[i];
        }
    }

    long rangeSum(int left, int right) { // inclusive
        return prefix[right + 1] - prefix[left];
    }
}
```

Use for O(1) range queries after O(n) preprocessing. 2D prefix sum for matrix region queries.

---

## Appendix D: Topological Sort (Kahn's Algorithm) — Full Template

```java
public List<Integer> topologicalSort(int n, List<List<Integer>> graph) {
    int[] inDegree = new int[n];
    for (List<Integer> neighbors : graph) {
        for (int v : neighbors) inDegree[v]++;
    }

    Queue<Integer> queue = new ArrayDeque<>();
    for (int i = 0; i < n; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }

    List<Integer> order = new ArrayList<>();
    while (!queue.isEmpty()) {
        int u = queue.poll();
        order.add(u);
        for (int v : graph.get(u)) {
            if (--inDegree[v] == 0) queue.offer(v);
        }
    }
    return order.size() == n ? order : List.of(); // empty if cycle
}
```

---

## Appendix E: Matrix Traversal Patterns

```java
// 4-directional BFS on grid
int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};

for (int[] d : dirs) {
    int nr = r + d[0], nc = c + d[1];
    if (nr >= 0 && nc >= 0 && nr < rows && nc < cols) {
        // process neighbor
    }
}

// Diagonal traversal, spiral matrix — practice LC 54, 48
```

---

## Appendix F: Common Mistakes Senior Candidates Still Make

1. **Off-by-one in binary search** — use half-open `[lo, hi)` or consistent `<=` with `lo/hi` updates
2. **Modifying collection while iterating** — use iterator.remove() or iterate backwards
3. **Integer overflow** — `mid = lo + (hi - lo) / 2`, use `long` for sums
4. **Forgetting to clone path in backtracking** — always `new ArrayList<>(path)` when adding to result
5. **Not pruning in backtracking** — sort + early break saves exponential time
6. **Using BFS on weighted graphs** — BFS only gives shortest path when all edges weight 1
7. **Confusing min-heap vs max-heap for top-K** — top K largest → min-heap of size K
8. **Mutating shared state in concurrent code** — always discuss locks or concurrent collections
9. **Ignoring input constraints** — n=10⁵ demands O(n log n), not O(n²)
10. **Silent about trade-offs** — senior role requires articulating why, not just coding

---

## Appendix G: Recommended Practice Progression

### Week 1 — Foundations
- Hash map: Two Sum, Group Anagrams, Subarray Sum K
- Two pointers: Valid Palindrome, 3Sum, Container Water
- Sliding window: Longest Substring, Min Window

### Week 2 — Search & Sort
- Binary search: Rotated Array, Koko Bananas, Median of Arrays
- Sorting: Merge Intervals, Meeting Rooms, Custom comparators

### Week 3 — Trees & Graphs
- Tree: Level order, Validate BST, LCA, Path Sum
- Graph: Islands, Course Schedule, Word Ladder, Dijkstra

### Week 4 — Advanced
- Heap: Top K, Merge K Lists, Task Scheduler
- Union-Find: Provinces, Redundant Connection
- DP: Coin Change, LIS, Edit Distance, Knapsack
- Backtracking: Subsets, Permutations, N-Queens
- Design: LRU Cache, Trie, Median Finder

---

## Appendix H: Verbal Framework for "Design + Code" Questions

Many senior loops combine system design with implementation:

**Example:** "Design a rate-limited API cache with TTL and LRU eviction."

**Structure your answer:**

1. **Requirements:** max size, TTL per entry, thread safety, hit/miss metrics
2. **API:** `get(key)`, `put(key, value)`, `invalidate(key)`
3. **Data structures:** `ConcurrentHashMap` + access-ordered `LinkedHashMap` or Caffeine
4. **Eviction:** LRU when size exceeded; lazy TTL check on get or periodic cleanup
5. **Rate limiting:** Token bucket per API key (separate concern, compose modules)
6. **Code:** Implement core `get`/`put` with LRU (15 lines)
7. **Scale:** "Single JVM → Caffeine; distributed → Redis with `SETEX` + application-side LRU index"

---

*End of reference. Target: pattern recognition → template → adapt → analyze complexity → connect to production.*
