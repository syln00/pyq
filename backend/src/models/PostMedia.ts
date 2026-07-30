import { DataTypes, Model } from "sequelize";
import sequelize from "../config/database";

interface PostMediaAttributes {
  postId: string;
  mediaId: string;
  createdAt: Date;
  updatedAt: Date;
}

class PostMedia extends Model<PostMediaAttributes, Pick<PostMediaAttributes, "postId" | "mediaId">>
  implements PostMediaAttributes {
  declare postId: string;
  declare mediaId: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

PostMedia.init(
  {
    postId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: { model: "posts", key: "id" },
      onDelete: "CASCADE",
    },
    mediaId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: { model: "media", key: "id" },
      onDelete: "CASCADE",
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: "post_media", underscored: true }
);

export default PostMedia;
