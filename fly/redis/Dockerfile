# Private Redis for the Fly deployment. AOF persisted on the mounted volume.
FROM redis:7-alpine
CMD ["redis-server", "--appendonly", "yes", "--save", ""]
