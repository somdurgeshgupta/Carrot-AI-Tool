CREATE EXTENSION IF NOT EXISTS vector;

-- The production schema uses a native vector column. Run the versioned TypeORM
-- migration rather than applying this helper manually to an existing database.
CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw
ON document_chunks
USING hnsw (embedding vector_cosine_ops)
WHERE embedding IS NOT NULL;
