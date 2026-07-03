"""
Kafka infrastructure service management.

Ported from bitswan-automation-server/internal/services/kafka.go.
"""

import base64
import logging
import os
import secrets as secrets_module

from app.services.infra_service import (
    InfraService,
    generate_password,
    run_docker_command,
)

logger = logging.getLogger(__name__)


def generate_cluster_id() -> str:
    """Generate a random Kafka cluster ID (URL-safe base64-encoded 16 random bytes)."""
    raw = secrets_module.token_bytes(16)
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


class KafkaService(InfraService):
    """Manages Kafka service deployment (Kafka broker + Kafka UI)."""

    DEFAULT_KAFKA_IMAGE = "confluentinc/cp-kafka:7.5.0"
    DEFAULT_UI_IMAGE = "provectuslabs/kafka-ui:latest"

    def __init__(
        self,
        workspace_name: str,
        stage: str = "production",
        kafka_image: str = "",
        ui_image: str = "",
    ):
        super().__init__(workspace_name, stage)
        self.kafka_image = kafka_image or self.DEFAULT_KAFKA_IMAGE
        self.ui_image = ui_image or self.DEFAULT_UI_IMAGE

    @property
    def service_type(self) -> str:
        return "kafka"

    @property
    def ui_container_name(self) -> str:
        return f"{self.workspace_name}__kafka{self.service_suffix}-ui"

    def _generate_secrets_content(self) -> str:
        admin_password = generate_password()
        ui_password = generate_password()
        kafka_host = self.container_name
        cluster_id = generate_cluster_id()

        jaas_config = (
            f"org.apache.kafka.common.security.plain.PlainLoginModule required "
            f'username="admin" password="{admin_password}" '
            f'user_admin="{admin_password}";'
        )

        lines = [
            f"KAFKA_ADMIN_PASSWORD={admin_password}",
            f"KAFKA_UI_PASSWORD={ui_password}",
            f"KAFKA_HOSTNAME={kafka_host}",
            f"KAFKA_CLUSTER_ID={cluster_id}",
            f"KAFKA_LISTENER_NAME_SASL_PLAINTEXT_PLAIN_SASL_JAAS_CONFIG='{jaas_config}'",
            f"SPRING_SECURITY_USER_PASSWORD={ui_password}",
            f"KAFKA_CLUSTERS_0_PROPERTIES_SASL_JAAS_CONFIG='{jaas_config}'",
        ]
        return "\n".join(lines) + "\n"

    async def stop(self) -> dict:
        """Stop both Kafka broker and UI containers."""
        result = await super().stop()
        # Also stop the UI container
        try:
            await run_docker_command("docker", "stop", self.ui_container_name)
        except Exception as e:
            logger.warning(f"Failed to stop Kafka UI container: {e}")
        return result

    def _get_caddy_upstream(self) -> str:
        # Kafka UI is the web-accessible service
        return f"{self.ui_container_name}:8080"

    def _get_connection_info(self) -> dict:
        info = {
            "broker": f"{self.container_name}:9092",
            "protocol": "SASL_PLAINTEXT",
        }
        if os.path.exists(self.secrets_file_path):
            with open(self.secrets_file_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("KAFKA_ADMIN_PASSWORD="):
                        info["admin_password"] = line.split("=", 1)[1]
                    elif line.startswith("KAFKA_UI_PASSWORD="):
                        info["ui_password"] = line.split("=", 1)[1]
        if self.gitops_domain:
            info["ui_url"] = f"https://{self.caddy_hostname()}/kafka"
        return info
