import { DataTypes, Model } from "sequelize";
import sequelize from "../config/database";

interface PostVisibleUserAttributes {
  postId: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

class PostVisibleUser extends Model<PostVisibleUserAttributes, Pick<PostVisibleUserAttributes, "postId" | "userId">>
  implements PostVisibleUserAttributes {
  declare postId: string;
  declare userId: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

PostVisibleUser.init(
  {
    postId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: { model: "posts", key: "id" },
      onDelete: "CASCADE",
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: "post_visible_users", underscored: true }
);

export default PostVisibleUser;
