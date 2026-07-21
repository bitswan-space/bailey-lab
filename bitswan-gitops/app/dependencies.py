import hmac
import os
from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from app.services.automation_service import AutomationService
from app.services.image_service import ImageService


def verify_token(credentials: HTTPAuthorizationCredentials = Security(HTTPBearer())):
    secret_token = os.environ.get("BITSWAN_GITOPS_SECRET")
    if (
        credentials.scheme != "Bearer"
        or not secret_token
        or not hmac.compare_digest(
            credentials.credentials.encode(), secret_token.encode()
        )
    ):
        raise HTTPException(
            status_code=401,
            detail="Unauthorized: Invalid or missing token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def get_image_service():
    return ImageService()


_automation_service = AutomationService()


def get_automation_service():
    return _automation_service
