from fastapi import FastAPI

from app.routers.health import router as health_router

app = FastAPI(
    title="Vehicle Tracking API",
    version="0.1.0",
    description="Backend API for vehicle tracking.",
)

app.include_router(health_router)


@app.get("/")
async def root():
    return {"message": "Vehicle Tracking API is running"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000 , reload= True )
    