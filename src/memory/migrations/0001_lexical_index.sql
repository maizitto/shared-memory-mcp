-- Additive lexical statistics and synchronous invalidation. Generated; do not split trigger bodies.

CREATE TABLE memory_lexical_docs (
 owner_id TEXT NOT NULL, collection_id TEXT NOT NULL, fact_id TEXT NOT NULL,
 version INTEGER NOT NULL, policy TEXT NOT NULL,
 word_count INTEGER NOT NULL CHECK(typeof(word_count)='integer' AND word_count>0),
 chunk_count INTEGER NOT NULL CHECK(typeof(chunk_count)='integer' AND chunk_count BETWEEN 1 AND 32),
 terms_json TEXT NOT NULL CHECK(json_valid(terms_json) AND json_type(terms_json)='object'),
 PRIMARY KEY(owner_id,collection_id,fact_id),
 FOREIGN KEY(owner_id,collection_id,fact_id,version) REFERENCES memory_versions(owner_id,collection_id,fact_id,version) ON DELETE CASCADE);

CREATE TRIGGER memory_lexical_head_changed AFTER UPDATE OF version,deleted ON memory_facts
 WHEN NEW.version!=OLD.version OR NEW.deleted!=OLD.deleted BEGIN
 DELETE FROM memory_lexical_docs WHERE owner_id=NEW.owner_id AND collection_id=NEW.collection_id AND fact_id=NEW.id;
END;

CREATE TRIGGER memory_lexical_head_removed AFTER DELETE ON memory_facts BEGIN
 DELETE FROM memory_lexical_docs WHERE owner_id=OLD.owner_id AND collection_id=OLD.collection_id AND fact_id=OLD.id;
END;

CREATE TRIGGER memory_lexical_version_removed AFTER DELETE ON memory_versions BEGIN
 DELETE FROM memory_lexical_docs WHERE owner_id=OLD.owner_id AND collection_id=OLD.collection_id AND fact_id=OLD.fact_id AND version=OLD.version;
END;

CREATE TRIGGER memory_lexical_payload_changed AFTER UPDATE OF payload_json ON memory_versions
 WHEN NEW.payload_json!=OLD.payload_json BEGIN
 DELETE FROM memory_lexical_docs WHERE owner_id=NEW.owner_id AND collection_id=NEW.collection_id AND fact_id=NEW.fact_id AND version=NEW.version;
END;
