from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from app.services.image_service import ImageService
from app.dependencies import get_image_service

router = APIRouter(prefix="/images", tags=["images"])


@router.get("/")
async def get_images(
    image_service: ImageService = Depends(get_image_service),
):
    # Now fully async using aiohttp Docker client
    return await image_service.get_images()


@router.get("/builds/{checksum}/stream")
async def stream_image_build_logs(
    checksum: str,
    image_service: ImageService = Depends(get_image_service),
):
    log_generator = image_service.stream_build_logs(checksum)
    return StreamingResponse(log_generator, media_type="text/plain")


@router.post("/{image_tag}")
async def create_image(
    image_tag: str,
    file: UploadFile = File(...),
    checksum: str = Form(...),
    image_service: ImageService = Depends(get_image_service),
):
    if file.filename.endswith((".zip", ".tar.gz", ".tgz")):
        result = await image_service.create_image(image_tag, file, checksum=checksum)
        return JSONResponse(content=result)
    else:
        raise HTTPException(
            status_code=400, detail="File must be a .zip or .tar.gz archive"
        )
