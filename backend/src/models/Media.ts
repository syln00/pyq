import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../config/database";

export type StorageType = "r2" | "s3";
export type MediaAccessClass = "owner_only" | "post_bound" | "public_asset";

export type MediaCategory = "image" | "video" | "audio" | "file";
export type MediaKind = "image" | "video" | "audio" | "lyric" | "file";

interface MediaAttributes {
  id: string;
  filename: string;
  url: string;
  storageType: StorageType;
  /** S3 provider-neutral object key. New records must use this instead of parsing URL. */
  objectKey: string;
  /** Optional WebP derivative used by timeline and media-library previews. */
  previewObjectKey: string;
  /** Display dimensions of the generated preview, or the original when no derivative is needed. */
  width: number | null;
  height: number | null;
  /** SHA-256 hex digest used for per-uploader deduplication. */
  contentHash: string | null;
  accessClass: MediaAccessClass;
  mimeType: string;
  kind: MediaKind;
  size: number;
  uploaderId: string;
  /**
   * 实况图配对字段（仅对 image 类型有意义）。
   * 当此图片是实况图的图片组件时，记录其配对视频的 URL。
   * 媒体库网格中将以"实况图"形式整体展示，点击后分开显示图与视频。
   */
  livePhotoVideo: string | null;
  /**
   * 实况图配对字段（仅对 video 类型有意义）。
   * 当此视频是实况图的视频组件时，记录其配对图片的 URL。
   * 此字段不为 null 的记录会在媒体库网格中隐藏（已被合并到对应图片条目中）。
   */
  livePhotoImage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MediaCreationAttributes extends Optional<
  MediaAttributes,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "livePhotoVideo"
  | "livePhotoImage"
  | "objectKey"
  | "previewObjectKey"
  | "width"
  | "height"
  | "contentHash"
  | "accessClass"
> {}

class Media
  extends Model<MediaAttributes, MediaCreationAttributes>
  implements MediaAttributes
{
  declare id: string;
  declare filename: string;
  declare url: string;
  declare storageType: StorageType;
  declare objectKey: string;
  declare previewObjectKey: string;
  declare width: number | null;
  declare height: number | null;
  declare contentHash: string | null;
  declare accessClass: MediaAccessClass;
  declare mimeType: string;
  declare kind: MediaKind;
  declare size: number;
  declare uploaderId: string;
  declare livePhotoVideo: string | null;
  declare livePhotoImage: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

Media.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    filename: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    url: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    storageType: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "s3",
    },
    objectKey: {
      type: DataTypes.STRING(600),
      allowNull: false,
      defaultValue: "",
    },
    previewObjectKey: {
      type: DataTypes.STRING(600),
      allowNull: false,
      defaultValue: "",
    },
    width: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      defaultValue: null,
    },
    height: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      defaultValue: null,
    },
    contentHash: {
      type: DataTypes.STRING(64),
      allowNull: true,
      defaultValue: null,
    },
    accessClass: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "owner_only",
    },
    mimeType: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: "application/octet-stream",
    },
    kind: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "file",
    },
    size: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    uploaderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    livePhotoVideo: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: null,
    },
    livePhotoImage: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: null,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: "media",
    underscored: true,
    indexes: [
      {
        name: "media_uploader_hash_kind_unique",
        unique: true,
        fields: ["uploader_id", "content_hash", "kind"],
      },
    ],
  }
);

export function getMediaCategory(mimeType: string): MediaCategory {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

export default Media;
