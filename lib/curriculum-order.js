/**
 * Sidebar curriculum order: folders first, then notes within each folder.
 * Paths use note ids (see lib/notes.js slugify).
 */

const FOLDER_ORDER = ["Java", "Database", "algorithms", "Spring", "microservices"];

const GROUP_LABELS = {
  Java: "Java",
  Database: "Database",
  algorithms: "Algorithms",
  Spring: "Spring",
  microservices: "Microservices",
};

const NOTE_ORDER_BY_FOLDER = {
  Java: [
    "java/java-oops",
    "java/java-design-patterns",
    "java/java-generics",
    "java/java-collections",
    "java/java-strings-course",
    "java/java_exceptions",
    "java/java-8-11-17-21",
    "java/java-streams",
    "java/java-datetime",
    "java/java-serialization",
    "java/java-reflection-and-proxies",
    "java/java-testing",
    "java/jvm_jmm_notes",
    "java/java-concurrency",
  ],
  Database: ["database/sql_and_rdbms", "database/nosql"],
  algorithms: ["algorithms/interview-algorithms"],
  Spring: [
    "spring/spring_core",
    "spring/spring_boot",
    "spring/spring_mvc_and_rest",
    "spring/spring_data_jpa_and_transactions",
    "spring/spring_caching",
    "spring/spring_security",
    "spring/spring_graphql",
    "spring/spring_webflux",
    "spring/spring_batch",
    "spring/spring_cloud",
  ],
  microservices: [
    "microservices/core-architecture",
    "microservices/distributed-systems-fundamentals",
    "microservices/service-communication",
    "microservices/messaging-event-driven",
    "microservices/kafka-mq-solace-topics",
    "microservices/service-management",
    "microservices/resilience-fault-tolerance",
    "microservices/distributed-data-transactions",
    "microservices/data-reliability",
    "microservices/caching",
    "microservices/security",
    "microservices/observability-monitoring",
    "microservices/deployment-devops",
    "microservices/scalability-availability",
    "microservices/kubernetes-resource-management",
    "microservices/testing",
    "microservices/api-design-evolution",
    "microservices/design-patterns",
    "microservices/system-design-interviews",
    "microservices/production-troubleshooting",
  ],
};

function folderOrderIndex(folder) {
  const idx = FOLDER_ORDER.indexOf(folder);
  return idx === -1 ? FOLDER_ORDER.length : idx;
}

function noteOrderIndex(folder, id) {
  const list = NOTE_ORDER_BY_FOLDER[folder];
  if (!list) return 9999;
  const idx = list.indexOf(id);
  return idx === -1 ? 9999 : idx;
}

function groupLabel(folder) {
  return GROUP_LABELS[folder] || folder;
}

function sortNotesForCurriculum(notes) {
  return [...notes].sort((a, b) => {
    const folderA = a.description || "Notes";
    const folderB = b.description || "Notes";
    const folderCmp = folderOrderIndex(folderA) - folderOrderIndex(folderB);
    if (folderCmp !== 0) return folderCmp;
    return noteOrderIndex(folderA, a.id) - noteOrderIndex(folderB, b.id);
  });
}

function annotateCurriculumOrder(notes) {
  return sortNotesForCurriculum(notes).map((note) => {
    const folder = note.description || "Notes";
    return {
      ...note,
      folderOrder: folderOrderIndex(folder),
      noteOrder: noteOrderIndex(folder, note.id),
      groupLabel: groupLabel(folder),
    };
  });
}

module.exports = {
  FOLDER_ORDER,
  folderOrderIndex,
  noteOrderIndex,
  groupLabel,
  sortNotesForCurriculum,
  annotateCurriculumOrder,
};
