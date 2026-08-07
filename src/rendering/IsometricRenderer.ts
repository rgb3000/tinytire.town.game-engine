import { Renderer } from './Renderer';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../constants';

const ISO_ELEVATION = 35 * (Math.PI / 180); // ~35° elevation
const ISO_AZIMUTH = 45 * (Math.PI / 180);   // 45° azimuth
const CAMERA_DISTANCE = 800;
const PAN_SPEED = 0; // no camera drift
const PAN_RADIUS_X = CANVAS_WIDTH * 0.15;
const PAN_RADIUS_Z = CANVAS_HEIGHT * 0.15;

export class IsometricRenderer extends Renderer {
  private panAngle = 0;
  private isoPanCenterX = CANVAS_WIDTH / 2;
  private isoPanCenterZ = CANVAS_HEIGHT / 2;

  protected override updateCameraPosition(): void {
    // Slow auto-pan: drift the look-at point in an ellipse around map center
    this.panAngle += PAN_SPEED;
    const lookX = this.isoPanCenterX + Math.sin(this.panAngle) * PAN_RADIUS_X;
    const lookZ = this.isoPanCenterZ + Math.cos(this.panAngle * 0.7) * PAN_RADIUS_Z;

    // Isometric offset from look-at point
    const offsetX = Math.cos(ISO_AZIMUTH) * Math.cos(ISO_ELEVATION) * CAMERA_DISTANCE;
    const offsetY = Math.sin(ISO_ELEVATION) * CAMERA_DISTANCE;
    const offsetZ = Math.sin(ISO_AZIMUTH) * Math.cos(ISO_ELEVATION) * CAMERA_DISTANCE;

    this.camera.up.set(0, 1, 0);
    this.camera.position.set(lookX + offsetX, offsetY, lookZ + offsetZ);
    this.camera.lookAt(lookX, 0, lookZ);

    // Update center values so frustum computation stays consistent
    this.cameraCenterX = lookX;
    this.cameraCenterZ = lookZ;
  }

  protected override updateFrustum(): void {
    // Use a fixed zoom that shows a nice portion of the map
    const zoom = 4.0;
    const { halfW, halfH } = this.computeHalfSizes(zoom);

    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.near = 0.1;
    this.camera.far = 5000;
    this.camera.updateProjectionMatrix();
  }
}
